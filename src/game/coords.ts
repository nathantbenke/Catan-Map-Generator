import type { AxialCoord, Hex, Intersection } from './types';

export const HEX_SIZE = 1;

export function axialToPixel({ q, r }: AxialCoord): { x: number; y: number } {
  const x = HEX_SIZE * Math.sqrt(3) * (q + r / 2);
  const y = HEX_SIZE * (3 / 2) * r;
  return { x, y };
}

const NEIGHBOR_OFFSETS: AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function neighbors(c: AxialCoord): AxialCoord[] {
  return NEIGHBOR_OFFSETS.map(o => ({ q: c.q + o.q, r: c.r + o.r }));
}

export function axialKey({ q, r }: AxialCoord): string {
  return `${q},${r}`;
}

export function hexCornerOffset(corner: number): { x: number; y: number } {
  const angleDeg = 60 * corner - 90;
  const angleRad = (Math.PI / 180) * angleDeg;
  return { x: HEX_SIZE * Math.cos(angleRad), y: HEX_SIZE * Math.sin(angleRad) };
}

export function hexCorner(hex: AxialCoord, corner: number): { x: number; y: number } {
  const c = axialToPixel(hex);
  const o = hexCornerOffset(corner);
  return { x: c.x + o.x, y: c.y + o.y };
}

const COORD_PRECISION = 1000;

function pointKey(x: number, y: number): string {
  return `${Math.round(x * COORD_PRECISION)},${Math.round(y * COORD_PRECISION)}`;
}

export function buildHexLayout(rows: number[]): AxialCoord[] {
  // For pointy-top axial coords, each hex sits at x = sqrt(3)*(q + r/2).
  // To center a row of width w on x=0, the row's average q must equal -r/2.
  // We round qStart to the integer that keeps every row visually centered
  // (within 0.5 hex when w and r parities clash, which is unavoidable).
  //
  // When r parity matches width parity (e.g. expansion 3-4-5-6-5-4-3 where
  // every odd row has odd width), the ideal qStart is half-integer for every
  // row. The default floor-round flips direction between consecutive rows,
  // producing a staggered/zigzag layout. We force odd rows to round in the
  // SAME direction as adjacent even rows so the whole board ends up uniformly
  // shifted to one side instead of zigzagged — the bbox-centered water frame
  // re-centers the whole thing visually anyway.
  const coords: AxialCoord[] = [];
  const centerRowIdx = Math.floor(rows.length / 2);
  rows.forEach((width, rowIdx) => {
    const r = rowIdx - centerRowIdx;
    let qStart = Math.floor(-r / 2) - Math.floor((width - 1) / 2);
    const rIsOdd = Math.abs(r) % 2 === 1;
    const wIsOdd = width % 2 === 1;
    if (rIsOdd && wIsOdd) qStart += 1;
    for (let i = 0; i < width; i++) {
      coords.push({ q: qStart + i, r });
    }
  });
  return coords;
}

export interface IntersectionGraph {
  intersections: Map<string, Intersection>;
  byHexCorner: Map<string, string>;
  hexIntersections: Map<string, string[]>;
}

export function buildIntersectionGraph(hexes: Hex[]): IntersectionGraph {
  const intersections = new Map<string, Intersection>();
  const byHexCorner = new Map<string, string>();
  const hexIntersections = new Map<string, string[]>();
  const pointToId = new Map<string, string>();

  for (const hex of hexes) {
    const list: string[] = [];
    for (let c = 0; c < 6; c++) {
      const { x, y } = hexCorner(hex, c);
      const pk = pointKey(x, y);
      let id = pointToId.get(pk);
      if (!id) {
        id = `i${intersections.size}`;
        pointToId.set(pk, id);
        intersections.set(id, { id, hexIds: [], neighbors: [], x, y });
      }
      const inter = intersections.get(id)!;
      if (!inter.hexIds.includes(hex.id)) inter.hexIds.push(hex.id);
      byHexCorner.set(`${hex.id}:${c}`, id);
      list.push(id);
    }
    hexIntersections.set(hex.id, list);
  }

  for (const hex of hexes) {
    for (let c = 0; c < 6; c++) {
      const a = byHexCorner.get(`${hex.id}:${c}`);
      const b = byHexCorner.get(`${hex.id}:${(c + 1) % 6}`);
      if (!a || !b) continue;
      const ai = intersections.get(a)!;
      const bi = intersections.get(b)!;
      if (!ai.neighbors.includes(b)) ai.neighbors.push(b);
      if (!bi.neighbors.includes(a)) bi.neighbors.push(a);
    }
  }

  return { intersections, byHexCorner, hexIntersections };
}
