import { boardFor } from './constants';
import { axialKey, buildHexLayout, neighbors } from './coords';
import type { Hex, PlayerCount } from './types';

export interface EmptyLayout {
  hexes: Hex[];
  perimeterPortSlots: Array<{ hexId: string; side: 0 | 1 | 2 | 3 | 4 | 5 }>;
}

// 9 port slots around the base-game perimeter, ordered clockwise from the
// top-left starting position. Spacing along the 30-edge perimeter follows the
// canonical (3, 4, 3, 3, 4, 3, 3, 4, 3) gap pattern, which produces the
// 5th-edition box layout (1–2 ports per side, alternating clusters).
const STANDARD_PORT_SIDES_BASE: Array<{ q: number; r: number; side: 0 | 1 | 2 | 3 | 4 | 5 }> = [
  { q: 0,  r: -2, side: 5 },  // slot 0 — top-left port (the starting point)
  { q: 1,  r: -2, side: 0 },  // slot 1 — top middle (3 edges CW from slot 0)
  { q: 2,  r: -1, side: 0 },  // slot 2 — upper-right (4 CW)
  { q: 2,  r:  0, side: 1 },  // slot 3 — right (3 CW)
  { q: 1,  r:  1, side: 2 },  // slot 4 — lower-right (3 CW)
  { q: -1, r:  2, side: 2 },  // slot 5 — bottom middle-right (4 CW)
  { q: -2, r:  2, side: 3 },  // slot 6 — bottom-left (3 CW)
  { q: -2, r:  1, side: 4 },  // slot 7 — left-lower (3 CW)
  { q: -1, r: -1, side: 4 },  // slot 8 — left-upper (4 CW; +3 returns to slot 0)
];

// 11 port slots around the 5-6 expansion perimeter (30 hexes in rows
// 3-4-5-6-5-4-3, 38 perimeter edges). Positions are specified by perimeter
// edge number in CW order — edges 1..38 start at the NW side of the top-row
// leftmost hex (1,-3) and walk CW. The mapping below is the canonical
// 5-6 expansion port placement.
const STANDARD_PORT_SIDES_EXPANSION: Array<{ q: number; r: number; side: 0 | 1 | 2 | 3 | 4 | 5 }> = [
  { q:  2, r: -3, side: 5 },  // edge 3  — top row, second-from-left
  { q:  3, r: -3, side: 0 },  // edge 6  — top-right peak
  { q:  3, r: -2, side: 1 },  // edge 9  — upper-right E
  { q:  3, r:  0, side: 0 },  // edge 12 — right side, upper NE
  { q:  2, r:  1, side: 1 },  // edge 15 — right side, lower E
  { q:  0, r:  3, side: 2 },  // edge 20 — bottom-right SE
  { q: -1, r:  3, side: 3 },  // edge 23 — bottom row, middle SW
  { q: -2, r:  2, side: 3 },  // edge 27 — bottom-left SW
  { q: -2, r:  0, side: 4 },  // edge 32 — left side, middle W
  { q: -1, r: -1, side: 5 },  // edge 35 — upper-left NW
  { q:  1, r: -3, side: 4 },  // edge 38 — top row, leftmost W
];

export function buildEmptyLayout(playerCount: PlayerCount): EmptyLayout {
  const spec = boardFor(playerCount);
  const coords = buildHexLayout(spec.rows);
  const hexes: Hex[] = coords.map((c, idx) => ({
    id: `h${idx}`,
    q: c.q,
    r: c.r,
    resource: 'desert',
    number: null,
  }));
  const idByKey = new Map<string, string>();
  hexes.forEach(h => idByKey.set(axialKey({ q: h.q, r: h.r }), h.id));

  const portSpec = playerCount <= 4 ? STANDARD_PORT_SIDES_BASE : STANDARD_PORT_SIDES_EXPANSION;
  const perimeterPortSlots = portSpec
    .map(p => {
      const id = idByKey.get(axialKey({ q: p.q, r: p.r }));
      return id ? { hexId: id, side: p.side } : null;
    })
    .filter((p): p is { hexId: string; side: 0 | 1 | 2 | 3 | 4 | 5 } => p !== null);

  return { hexes, perimeterPortSlots };
}

export function hexNeighbors(hex: Hex, byKey: Map<string, Hex>): Hex[] {
  return neighbors({ q: hex.q, r: hex.r })
    .map(c => byKey.get(axialKey(c)))
    .filter((h): h is Hex => h !== undefined);
}

export function buildHexIndex(hexes: Hex[]): Map<string, Hex> {
  const m = new Map<string, Hex>();
  hexes.forEach(h => m.set(axialKey({ q: h.q, r: h.r }), h));
  return m;
}
