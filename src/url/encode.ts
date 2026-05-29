import type { MapState } from '../game/types';

// Compact wire format: only what's needed to reconstruct the map; full state is
// re-derivable by re-running scoring on load.
interface Wire {
  v: 1;
  s: string;
  p: number;
  h: Array<[number, number, string, number | null]>;
  o: Array<[string, number, string]>;
  z: {
    d: 0 | 1;
    dr: string;
    sp: 0 | 1;
    nn?: 0 | 1;
    nr?: 0 | 1;
    nm?: 0 | 1;
    /** Deprecated, ignored on decode. Older URLs may still carry it. */
    bp?: 0 | 1;
    c: { f: string; t: string; rf?: string; rt?: string };
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((s.length + 2) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeMapState(map: MapState): string {
  const wire: Wire = {
    v: 1,
    s: map.seed,
    p: map.playerCount,
    h: map.hexes.map(h => [h.q, h.r, h.resource, h.number]),
    o: map.ports.map(p => [p.hexId, p.side, p.type]),
    z: {
      d: map.variants.includeDesert ? 1 : 0,
      dr: map.variants.desertReplacement,
      sp: map.variants.shufflePorts ? 1 : 0,
      nn: map.variants.noSameNumberAdjacent ? 1 : 0,
      nr: map.variants.noSameNumberOnResource ? 1 : 0,
      nm: map.variants.noMultipleRedsOnResource ? 1 : 0,
      c: {
        f: map.variants.challenge.flavor,
        t: map.variants.challenge.targetResource,
        rf: map.variants.challenge.rolledFlavor,
        rt: map.variants.challenge.rolledTarget,
      },
    },
  };
  const json = JSON.stringify(wire);
  const bytes = new TextEncoder().encode(json);
  return toBase64Url(bytes);
}

export function decodeMapState(encoded: string): MapState {
  const bytes = fromBase64Url(encoded);
  const json = new TextDecoder().decode(bytes);
  const wire = JSON.parse(json) as Wire;
  if (wire.v !== 1) throw new Error(`Unsupported map version: ${wire.v}`);
  return {
    seed: wire.s,
    playerCount: wire.p as MapState['playerCount'],
    hexes: wire.h.map(([q, r, resource, number], i) => ({
      id: `h${i}`,
      q,
      r,
      resource: resource as MapState['hexes'][number]['resource'],
      number,
    })),
    ports: wire.o.map(([hexId, side, type]) => ({
      hexId,
      side: side as 0 | 1 | 2 | 3 | 4 | 5,
      type: type as MapState['ports'][number]['type'],
    })),
    variants: {
      includeDesert: wire.z.d === 1,
      desertReplacement: wire.z.dr as MapState['variants']['desertReplacement'],
      shufflePorts: wire.z.sp === 1,
      noSameNumberAdjacent: wire.z.nn === 1,
      noSameNumberOnResource: wire.z.nr === 1,
      noMultipleRedsOnResource: wire.z.nm === 1,
      challenge: {
        flavor: wire.z.c.f as MapState['variants']['challenge']['flavor'],
        targetResource: wire.z.c.t as MapState['variants']['challenge']['targetResource'],
        rolledFlavor: wire.z.c.rf as MapState['variants']['challenge']['rolledFlavor'],
        rolledTarget: wire.z.c.rt as MapState['variants']['challenge']['rolledTarget'],
      },
    },
  };
}

export function writeMapToUrl(map: MapState): void {
  const enc = encodeMapState(map);
  history.replaceState(null, '', `#m=${enc}`);
}

export function readMapFromUrl(): MapState | null {
  const hash = window.location.hash;
  if (!hash.startsWith('#m=')) return null;
  try {
    return decodeMapState(hash.slice(3));
  } catch {
    return null;
  }
}
