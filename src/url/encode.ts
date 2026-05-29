import { generateMap } from '../generator/generate';
import type {
  ChallengeFlavor,
  MapState,
  PlayerCount,
  ProducingResource,
  Variants,
} from '../game/types';

// Wire format v2 (current): seed + player count + non-default variant flags
// ONLY. The full hex/port data is dropped, and the recipient regenerates the
// same map by calling generateMap with the same seed + variants. Generation
// is deterministic (mulberry32 RNG keyed on the seed), so the result is
// guaranteed identical. Typical URL shrinks from ~1400 chars to ~50.
//
// Wire format v1 (legacy): full hex/port data. Kept for backward compat so
// links shared before the format change still load. Decoded in-place without
// re-running the generator.

interface WireZ {
  d?: 0 | 1;
  dr?: string;
  sp?: 0 | 1;
  nn?: 0 | 1;
  nr?: 0 | 1;
  nm?: 0 | 1;
  /** Deprecated v1 field (balance pips), ignored. */
  bp?: 0 | 1;
  c?: { f?: string; t?: string; rf?: string; rt?: string };
}

interface WireV2 {
  v: 2;
  s: string;
  p: number;
  z: WireZ;
}

interface WireV1 {
  v: 1;
  s: string;
  p: number;
  h: Array<[number, number, string, number | null]>;
  o: Array<[string, number, string]>;
  z: WireZ;
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
  // Only write fields that DIFFER from the defaults in defaultVariants(). A
  // typical balanced 4-player URL ends up with z: {} — ~50 chars total.
  const z: WireZ = {};
  if (!map.variants.includeDesert) {
    z.d = 0;
    z.dr = map.variants.desertReplacement;
  }
  if (map.variants.shufflePorts) z.sp = 1;
  if (!map.variants.noSameNumberAdjacent) z.nn = 0;
  if (!map.variants.noSameNumberOnResource) z.nr = 0;
  if (!map.variants.noMultipleRedsOnResource) z.nm = 0;
  if (map.variants.challenge.flavor !== 'none') {
    z.c = { f: map.variants.challenge.flavor };
    if (map.variants.challenge.targetResource !== 'any') {
      z.c.t = map.variants.challenge.targetResource;
    }
  }

  const wire: WireV2 = {
    v: 2,
    s: map.seed,
    p: map.playerCount,
    z,
  };
  const json = JSON.stringify(wire);
  const bytes = new TextEncoder().encode(json);
  return toBase64Url(bytes);
}

export function decodeMapState(encoded: string): MapState {
  const bytes = fromBase64Url(encoded);
  const json = new TextDecoder().decode(bytes);
  const wire = JSON.parse(json) as WireV1 | WireV2;
  if (wire.v === 2) return decodeV2(wire);
  if (wire.v === 1) return decodeV1(wire);
  throw new Error(`Unsupported map version: ${(wire as { v: number }).v}`);
}

function variantsFromZ(z: WireZ): Variants {
  return {
    includeDesert: z.d === undefined ? true : z.d === 1,
    desertReplacement: (z.dr ?? 'ore') as ProducingResource,
    shufflePorts: z.sp === 1,
    noSameNumberAdjacent: z.nn === undefined ? true : z.nn === 1,
    noSameNumberOnResource: z.nr === undefined ? true : z.nr === 1,
    noMultipleRedsOnResource: z.nm === undefined ? true : z.nm === 1,
    challenge: {
      flavor: (z.c?.f ?? 'none') as ChallengeFlavor,
      targetResource: (z.c?.t ?? 'any') as ProducingResource | 'any',
    },
  };
}

function decodeV2(wire: WireV2): MapState {
  // Re-run the generator with the same seed + variants. The RNG sequence is
  // deterministic, so this produces the byte-identical board the sender saw.
  const variants = variantsFromZ(wire.z);
  const result = generateMap({
    seed: wire.s,
    playerCount: wire.p as PlayerCount,
    variants,
  });
  return result.map;
}

function decodeV1(wire: WireV1): MapState {
  // Legacy path — rebuild MapState directly from the embedded hex/port data
  // so links shared on the old format don't break.
  return {
    seed: wire.s,
    playerCount: wire.p as PlayerCount,
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
      desertReplacement: wire.z.dr as ProducingResource,
      shufflePorts: wire.z.sp === 1,
      noSameNumberAdjacent: wire.z.nn === 1,
      noSameNumberOnResource: wire.z.nr === 1,
      noMultipleRedsOnResource: wire.z.nm === 1,
      challenge: {
        flavor: (wire.z.c?.f ?? 'none') as ChallengeFlavor,
        targetResource: (wire.z.c?.t ?? 'any') as ProducingResource | 'any',
        rolledFlavor: wire.z.c?.rf as MapState['variants']['challenge']['rolledFlavor'],
        rolledTarget: wire.z.c?.rt as MapState['variants']['challenge']['rolledTarget'],
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
