import { HIGH_YIELD_NUMBERS, LOW_YIELD_NUMBERS, PIP_VALUE, PRODUCING_RESOURCES } from '../game/constants';
import { buildIntersectionGraph, IntersectionGraph } from '../game/coords';
import type {
  FairnessReport,
  Hex,
  Intersection,
  PlayerCount,
  Port,
  ProducingResource,
  ResourceHealth,
  SpotScore,
} from '../game/types';

export interface ScoredMap {
  graph: IntersectionGraph;
  spots: Map<string, SpotScore>;
  health: ResourceHealth[];
  fairness: FairnessReport;
}

function pip(hex: Hex): number {
  return hex.number !== null ? PIP_VALUE[hex.number] : 0;
}

export function scoreMap(hexes: Hex[], ports: Port[], playerCount: PlayerCount): ScoredMap {
  const graph = buildIntersectionGraph(hexes);
  const hexById = new Map(hexes.map(h => [h.id, h] as const));

  const portByIntersection = new Map<string, { type: string; resource?: ProducingResource }>();
  for (const port of ports) {
    const idA = graph.byHexCorner.get(`${port.hexId}:${port.side}`);
    const idB = graph.byHexCorner.get(`${port.hexId}:${(port.side + 1) % 6}`);
    const meta = { type: port.type, resource: port.type === 'generic' ? undefined : (port.type as ProducingResource) };
    if (idA) portByIntersection.set(idA, meta);
    if (idB) portByIntersection.set(idB, meta);
  }

  // Per-map resource tile counts. Drives the scarcity bonus below: a resource
  // with fewer tiles on the board is harder to come by, so spots adjacent to
  // it deserve a small premium when ranking starting positions.
  const tilesPerResource = new Map<ProducingResource, number>();
  for (const h of hexes) {
    if (h.resource === 'desert') continue;
    tilesPerResource.set(h.resource, (tilesPerResource.get(h.resource) ?? 0) + 1);
  }
  const maxTiles = Math.max(0, ...tilesPerResource.values());

  // Pass 1: base spot scores (without expansion bonus).
  const baseSpots = new Map<string, SpotScore>();
  for (const inter of graph.intersections.values()) {
    baseSpots.set(
      inter.id,
      scoreSpot(inter, hexById, portByIntersection.get(inter.id), tilesPerResource, maxTiles),
    );
  }

  // Pass 2: expansion-potential bonus. For each intersection, look at the
  // distance-2 intersections (the closest legal future settlement spots under
  // the distance-2 rule, reachable with a single road). A spot surrounded by
  // viable expansion targets is "growable"; a spot at a dead end or hemmed
  // in by desert/ocean has nowhere to grow. The bonus is intentionally small
  // since the projection is speculative — competitors won't always take the
  // theoretically optimal picks.
  const spots = new Map<string, SpotScore>();
  for (const inter of graph.intersections.values()) {
    const base = baseSpots.get(inter.id)!;
    const distance2 = new Set<string>();
    for (const nb1Id of inter.neighbors) {
      const nb1 = graph.intersections.get(nb1Id);
      if (!nb1) continue;
      for (const nb2Id of nb1.neighbors) {
        if (nb2Id === inter.id) continue;
        if (inter.neighbors.includes(nb2Id)) continue;
        distance2.add(nb2Id);
      }
    }
    let viable = 0;
    for (const id of distance2) {
      const sp = baseSpots.get(id);
      // "Viable" = enough resource production to seriously consider as the
      // next settlement (pipValue ≥ 4 ≈ a single 5/9 hex or two low-pip hexes).
      if (sp && sp.pipValue >= 4) viable++;
    }
    // Typical central spot has ~6 distance-2 neighbors, an edge spot ~2-3.
    // Bonus magnitude clamped to ±0.6 so it nudges rather than dominates.
    const raw = (viable - 3) * 0.2;
    const expansionBonus = Math.max(-0.6, Math.min(0.6, raw));
    spots.set(inter.id, {
      ...base,
      expansionBonus,
      total: base.total + expansionBonus,
    });
  }

  const health = computeHealth(hexes);
  const fairness = simulateSnakeDraft(graph, spots, playerCount);

  return { graph, spots, health, fairness };
}

function scoreSpot(
  inter: Intersection,
  hexById: Map<string, Hex>,
  port: { type: string; resource?: ProducingResource } | undefined,
  tilesPerResource: Map<ProducingResource, number>,
  maxTiles: number,
): SpotScore {
  const adjHexes = inter.hexIds.map(id => hexById.get(id)!).filter(Boolean);
  const pipValue = adjHexes.reduce((s, h) => s + pip(h), 0);

  const uniqueResources = new Set(adjHexes.map(h => h.resource).filter(r => r !== 'desert'));
  const diversityBonus = Math.max(0, uniqueResources.size - 1) * 0.5;

  let portBonus = 0;
  if (port) {
    if (port.resource && adjHexes.some(h => h.resource === port.resource)) portBonus = 1.0;
    else portBonus = 0.3;
  }

  const numberToResources = new Map<number, Set<ProducingResource>>();
  const numberCounts = new Map<number, number>();
  for (const h of adjHexes) {
    if (h.number === null || h.resource === 'desert') continue;
    numberCounts.set(h.number, (numberCounts.get(h.number) ?? 0) + 1);
    if (!numberToResources.has(h.number)) numberToResources.set(h.number, new Set());
    numberToResources.get(h.number)!.add(h.resource as ProducingResource);
  }
  let hasRoadCombo = false;
  let hasCityCombo = false;
  for (const set of numberToResources.values()) {
    if (set.has('brick') && set.has('wood')) hasRoadCombo = true;
    if (set.has('ore') && set.has('wheat')) hasCityCombo = true;
  }
  const allSettlementResources =
    uniqueResources.has('brick') &&
    uniqueResources.has('wood') &&
    uniqueResources.has('wheat') &&
    uniqueResources.has('sheep');
  const hasSettlementCombo = allSettlementResources;

  let synergyBonus = 0;
  if (hasRoadCombo) synergyBonus += 1.5;
  if (hasCityCombo) synergyBonus += 1.5;
  if (hasSettlementCombo) synergyBonus += 0.5;

  // Same-number-on-multiple-adjacent-hexes is a double-edged sword: large
  // payout when the number rolls, but the spot depends on a SINGLE die roll
  // for its income (vs. the typical 2–3 distinct numbers at an intersection).
  // Penalty scaled by the duplicate's pip value (higher numbers hurt less
  // since they roll more often).
  let sameNumberPenalty = 0;
  for (const [num, count] of numberCounts) {
    if (count > 1) {
      const dupes = count - 1;
      const pip = (PIP_VALUE[num] ?? 0);
      // 6/8 dupe: small penalty (~0.6); 2/12 dupe: large penalty (~1.4)
      const perDupe = 1.6 - 0.2 * pip;
      sameNumberPenalty -= dupes * Math.max(0.4, perDupe);
    }
  }

  // Scarcity bonus: each UNIQUE adjacent resource type contributes a small
  // premium proportional to how scarce that resource is on this map (max
  // tile count minus this resource's tile count). On a standard board this
  // lifts spots adjacent to brick or ore (3 tiles) over otherwise-equal
  // spots adjacent only to 4-tile resources, since brick/ore are the harder
  // resources to trade for. When desert is replaced with ore, scarcity
  // shifts naturally because tile counts shift.
  let scarcityBonus = 0;
  for (const resource of uniqueResources) {
    const tiles = tilesPerResource.get(resource as ProducingResource) ?? 0;
    if (tiles > 0 && maxTiles > tiles) {
      scarcityBonus += (maxTiles - tiles) * 0.5;
    }
  }

  const total = pipValue + diversityBonus + portBonus + synergyBonus + scarcityBonus + sameNumberPenalty;

  return {
    intersectionId: inter.id,
    pipValue,
    diversityBonus,
    portBonus,
    synergyBonus,
    scarcityBonus,
    expansionBonus: 0, // filled in by the expansion-potential pass in scoreMap
    sameNumberPenalty,
    total,
    hasRoadCombo,
    hasCityCombo,
    hasSettlementCombo,
  };
}

function simulateSnakeDraft(
  graph: IntersectionGraph,
  spots: Map<string, SpotScore>,
  playerCount: PlayerCount,
): FairnessReport {
  const order: number[] = [];
  for (let i = 0; i < playerCount; i++) order.push(i);
  for (let i = playerCount - 1; i >= 0; i--) order.push(i);

  const blocked = new Set<string>();
  const picks: FairnessReport['picks'] = [];
  const playerTotals = new Array(playerCount).fill(0);

  for (const playerIdx of order) {
    const ranked = Array.from(spots.values())
      .filter(s => !blocked.has(s.intersectionId))
      .sort((a, b) => b.total - a.total);
    if (ranked.length === 0) break;
    const chosen = ranked[0];
    picks.push({ playerIndex: playerIdx, intersectionId: chosen.intersectionId, value: chosen.total });
    playerTotals[playerIdx] += chosen.total;
    blocked.add(chosen.intersectionId);
    const inter = graph.intersections.get(chosen.intersectionId)!;
    for (const nb of inter.neighbors) blocked.add(nb);
  }

  const mean = playerTotals.reduce((a, b) => a + b, 0) / playerTotals.length;
  const variance = playerTotals.reduce((a, b) => a + (b - mean) ** 2, 0) / playerTotals.length;
  const stdev = Math.sqrt(variance);
  const spread = Math.max(...playerTotals) - Math.min(...playerTotals);
  return { playerTotals, stdev, spread, picks };
}

export function computeHealth(hexes: Hex[]): ResourceHealth[] {
  return PRODUCING_RESOURCES.map(res => {
    const tiles = hexes.filter(h => h.resource === res);
    const pips = tiles.map(h => (h.number !== null ? PIP_VALUE[h.number] : 0));
    const totalPips = pips.reduce((a, b) => a + b, 0);
    const mean = pips.length ? totalPips / pips.length : 0;
    const pipVariance = pips.length ? pips.reduce((a, b) => a + (b - mean) ** 2, 0) / pips.length : 0;
    const numberPips = new Map<number, number>();
    for (const t of tiles) {
      if (t.number !== null) numberPips.set(t.number, (numberPips.get(t.number) ?? 0) + PIP_VALUE[t.number]);
    }
    let topNumber: number | null = null;
    let topPips = 0;
    for (const [n, p] of numberPips) {
      if (p > topPips) { topPips = p; topNumber = n; }
    }
    const concentration = totalPips > 0 ? topPips / totalPips : 0;
    return { resource: res, totalPips, pipVariance, concentration, topNumber, status: 'healthy' } as ResourceHealth;
  }).map(h => {
    const status: ResourceHealth['status'] =
      h.concentration > 0.6 ? 'unhealthy' : h.totalPips < 5 ? 'unhealthy' : h.totalPips < 7 ? 'warning' : 'healthy';
    return { ...h, status };
  });
}

export function isResourceHealthy(
  health: ResourceHealth[],
  hexes: Hex[],
  _playerCount: PlayerCount,
): boolean {
  const tilesByResource = new Map<string, Hex[]>();
  for (const h of hexes) {
    if (h.resource === 'desert') continue;
    if (!tilesByResource.has(h.resource)) tilesByResource.set(h.resource, []);
    tilesByResource.get(h.resource)!.push(h);
  }
  for (const h of health) {
    const tiles = tilesByResource.get(h.resource) ?? [];
    // Starved if average pip per tile < 1.7 (i.e. mostly 2s/12s/3s).
    if (h.totalPips < Math.ceil(tiles.length * 1.7)) return false;
    // Robber-vulnerable if >75% of pips on a single number AND the resource is small.
    if (tiles.length <= 3 && h.concentration > 0.8) return false;
    if (tiles.length >= 4 && h.concentration > 0.7) return false;
    // Each resource needs at least one high-yield number (5/6/8/9) so that
    // the resource isn't dead-on-arrival when its low-yield numbers don't roll.
    const hasHighYield = tiles.some(t => t.number !== null && HIGH_YIELD_NUMBERS.has(t.number));
    if (!hasHighYield) return false;
  }
  return true;
}

export function hasDroughtCluster(hexes: Hex[]): boolean {
  // Returns true if there is at least one triplet of mutually-adjacent hexes
  // all carrying low-yield numbers (2, 3, 11, 12).
  const byKey = new Map(hexes.map(h => [`${h.q},${h.r}`, h] as const));
  for (const hex of hexes) {
    if (hex.number === null || !LOW_YIELD_NUMBERS.has(hex.number)) continue;
    const nbs = [
      { q: hex.q + 1, r: hex.r }, { q: hex.q + 1, r: hex.r - 1 },
      { q: hex.q, r: hex.r - 1 }, { q: hex.q - 1, r: hex.r },
      { q: hex.q - 1, r: hex.r + 1 }, { q: hex.q, r: hex.r + 1 },
    ].map(c => byKey.get(`${c.q},${c.r}`)).filter((h): h is Hex => !!h && h.number !== null && LOW_YIELD_NUMBERS.has(h.number));
    for (let i = 0; i < nbs.length; i++) {
      for (let j = i + 1; j < nbs.length; j++) {
        const a = nbs[i];
        const b = nbs[j];
        const dq = a.q - b.q;
        const dr = a.r - b.r;
        const adj = (dq === 1 && dr === 0) || (dq === -1 && dr === 0) ||
                    (dq === 0 && dr === 1) || (dq === 0 && dr === -1) ||
                    (dq === 1 && dr === -1) || (dq === -1 && dr === 1);
        if (adj) return true;
      }
    }
  }
  return false;
}
