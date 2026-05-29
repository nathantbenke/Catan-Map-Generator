import { useGesture } from '@use-gesture/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../state/store';
import { axialToPixel, hexCorner } from '../game/coords';
import { PIP_VALUE, RED_NUMBERS } from '../game/constants';
import type { Hex, Port } from '../game/types';
import { PortGlyph, TileArt } from './TileIcon';

function hexPath(hex: Hex): string {
  const pts: string[] = [];
  for (let c = 0; c < 6; c++) {
    const { x, y } = hexCorner(hex, c);
    pts.push(`${x.toFixed(4)},${y.toFixed(4)}`);
  }
  return `M${pts.join(' L')} Z`;
}

function boundingBox(hexes: Hex[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const h of hexes) {
    for (let c = 0; c < 6; c++) {
      const { x, y } = hexCorner(h, c);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

// Axial offsets for each pointy-top hex side (where side k = edge between
// corner k and corner (k+1) % 6). Neighbor through side k is hex + delta[k].
//   side 0 = NE, 1 = E, 2 = SE, 3 = SW, 4 = W, 5 = NW
const SIDE_TO_NEIGHBOR: ReadonlyArray<{ dq: number; dr: number }> = [
  { dq:  1, dr: -1 }, // 0: NE
  { dq:  1, dr:  0 }, // 1: E
  { dq:  0, dr:  1 }, // 2: SE
  { dq: -1, dr:  1 }, // 3: SW
  { dq: -1, dr:  0 }, // 4: W
  { dq:  0, dr: -1 }, // 5: NW
];

interface PerimeterEdge {
  hexId: string;
  q: number;
  r: number;
  side: number;
  midpointX: number;
  midpointY: number;
}

/** Walk the land perimeter CW (visually: top → right → bottom → left → top)
 *  starting from the NW edge (side 5) of the top-row leftmost hex, returning
 *  every perimeter edge in order. Produces 30 edges for the base 19-hex
 *  board and 38 edges for the 5-6 expansion (3-4-5-6-5-4-3). */
function perimeterEdgesCW(hexes: Hex[]): PerimeterEdge[] {
  if (hexes.length === 0) return [];
  const byKey = new Map<string, Hex>();
  for (const h of hexes) byKey.set(`${h.q},${h.r}`, h);

  // Topmost-leftmost hex.
  let startHex = hexes[0];
  for (const h of hexes) {
    if (h.r < startHex.r || (h.r === startHex.r && h.q < startHex.q)) startHex = h;
  }

  // Pick the first perimeter side going CW from side 5 (NW). For a top-row
  // leftmost hex, side 5 (NW) is always perimeter — but the search is
  // defensive in case the starting hex shape changes.
  let startSide = 5;
  for (let i = 0; i < 6; i++) {
    const s = (5 + i) % 6;
    const d = SIDE_TO_NEIGHBOR[s];
    if (!byKey.has(`${startHex.q + d.dq},${startHex.r + d.dr}`)) {
      startSide = s;
      break;
    }
  }

  const result: PerimeterEdge[] = [];
  let curHex = startHex;
  let curSide = startSide;

  for (let safety = 0; safety < 200; safety++) {
    const a = hexCorner(curHex, curSide);
    const b = hexCorner(curHex, (curSide + 1) % 6);
    result.push({
      hexId: curHex.id,
      q: curHex.q,
      r: curHex.r,
      side: curSide,
      midpointX: (a.x + b.x) / 2,
      midpointY: (a.y + b.y) / 2,
    });

    // Find the next CW perimeter edge. Test side (curSide + 1) % 6 of curHex;
    // if it's internal (has a neighbor), step across into that neighbor and
    // continue at side ((side + 1) + 3) % 6 = (side + 4) % 6 of the neighbor
    // (the side on the neighbor at the same corner, going CW).
    let testHex = curHex;
    let testSide = (curSide + 1) % 6;
    for (let step = 0; step < 12; step++) {
      const d = SIDE_TO_NEIGHBOR[testSide];
      const neighbor = byKey.get(`${testHex.q + d.dq},${testHex.r + d.dr}`);
      if (!neighbor) break;
      testHex = neighbor;
      testSide = (testSide + 4) % 6;
    }

    curHex = testHex;
    curSide = testSide;
    if (curHex.id === startHex.id && curSide === startSide) break;
  }

  return result;
}

// Clearance (in hex units) between every land corner and the frame boundary
// at that corner's angle from center. Sized so roughly 3 wave ripples fit
// between the land's top/bottom edge and the frame (wave spacing = 0.45)
// while leaving enough room that port docks don't bleed past the frame line.
// The expansion's L/R sides naturally look more spacious than top/bottom
// because the land's middle row is wider than its top/bottom rows — this is
// a property of the land shape, not the frame.
const FRAME_MARGIN = 1.15;

/** Regular flat-top hex frame circumscribing the land, sized so every land
 *  corner has at least `margin` clearance to the frame boundary at the
 *  corner's angle from center (NOT just to the nearest hex corner). Used by
 *  BOTH the base game and the 5-6 expansion so all 6 frame sides are equal —
 *  only the seam-break pattern differs. */
function regularHexFrame(hexes: Hex[], margin: number): {
  cx: number; cy: number; landR: number; R: number; corners: [number, number][];
} {
  const { minX, maxX, minY, maxY } = boundingBox(hexes);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // For a flat-top regular hex with circumradius R, the boundary distance at
  // angle θ from center is (R·√3/2) / cos(θ − α), where α = sector midpoint
  // angle (30° + k·60°). To guarantee `margin` clearance to a land corner at
  // distance d, angle θ:
  //   d + margin ≤ (R·√3/2) / cos(θ − α)
  //   R ≥ (d + margin) · cos(θ − α) · 2/√3
  // The naive `maxLandR + margin` underestimates R for corners that land
  // close to an edge midpoint (e.g. the topmost-leftmost hex of the
  // expansion's staggered top row), causing ports to bleed off the frame.
  let R = 0;
  let landR = 0;
  const sectorRad = Math.PI / 3;
  for (const h of hexes) {
    for (let c = 0; c < 6; c++) {
      const { x, y } = hexCorner(h, c);
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > landR) landR = d;
      let a = Math.atan2(dy, dx);
      while (a < 0) a += 2 * Math.PI;
      const sector = Math.floor(a / sectorRad);
      const sideMidAngle = sector * sectorRad + sectorRad / 2;
      const offset = a - sideMidAngle;
      const required = (d + margin) * Math.cos(offset) * 2 / Math.sqrt(3);
      if (required > R) R = required;
    }
  }

  const corners: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const angle = (k * Math.PI) / 3; // 0°, 60°, ... → flat-top corners
    corners.push([cx + R * Math.cos(angle), cy + R * Math.sin(angle)]);
  }
  return { cx, cy, landR, R, corners };
}

function seaFramePath(hexes: Hex[], margin: number): string {
  const { corners } = regularHexFrame(hexes, margin);
  return `M${corners.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' L')} Z`;
}

// Intersect a ray from origin (angle θ) with a flat-top regular hex of
// circumradius R, returning the point on the hex outline (origin-relative).
function rayToFlatTopHex(angle: number, R: number): { x: number; y: number } {
  let a = angle;
  while (a < 0) a += 2 * Math.PI;
  a = a % (2 * Math.PI);
  const sectorRad = Math.PI / 3;
  const sector = Math.floor(a / sectorRad);
  const sideMidAngle = sector * sectorRad + sectorRad / 2;
  const inradius = (R * Math.sqrt(3)) / 2;
  const r = inradius / Math.cos(a - sideMidAngle);
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

// 10 land-hex corners where the 5-6 expansion frame pieces meet. Positions
// were specified by the user via the perimeter-numbers debug overlay (the
// breaks sit "between edge N and edge N+1", which is the END corner of edge N
// = corner (side+1) % 6 of edge N's hex). Walking CW from the top of (3,-3),
// segment lengths go 5-5-2-5-2-5-5-2-5-2 around the 38-edge perimeter.
const BREAK_LAND_CORNERS_EXPANSION: Array<{ q: number; r: number; corner: number; label: string }> = [
  { q:  3, r: -3, corner: 0, label: 'top of (3,-3)' },          // edge 5 end  — ends top main (label 4)
  { q:  3, r: -1, corner: 1, label: 'top-right of (3,-1)' },    // edge 10 end — ends TR main (label 5)
  { q:  3, r:  0, corner: 1, label: 'top-right of (3,0)' },     // edge 12 end — ends TR ext  (label 5)
  { q:  1, r:  2, corner: 2, label: 'bottom-right of (1,2)' },  // edge 17 end — ends R main  (label 6)
  { q:  0, r:  3, corner: 2, label: 'bottom-right of (0,3)' },  // edge 19 end — ends R ext   (label 6)
  { q: -2, r:  3, corner: 3, label: 'bottom of (-2,3)' },       // edge 24 end — ends bottom main (label 1)
  { q: -2, r:  1, corner: 4, label: 'bottom-left of (-2,1)' },  // edge 29 end — ends BL main (label 2)
  { q: -2, r:  0, corner: 4, label: 'bottom-left of (-2,0)' },  // edge 31 end — ends BL ext  (label 2)
  { q:  0, r: -2, corner: 5, label: 'top-left of (0,-2)' },     // edge 36 end — ends L main  (label 3)
  { q:  1, r: -3, corner: 5, label: 'top-left of (1,-3)' },     // edge 38 end — ends L ext   (label 3)
];

/** 10 wavy seam lines for the 5-6 expansion water frame. Each line emanates
 *  from a specific land-hex corner outward through the water to the outer
 *  edge of the regular hex frame. The seams split the frame into 10 pieces:
 *  6 main "5-edge" sides and 4 "2-edge" extensions. */
function FrameSeamsExpansion({ hexes, margin, rotation }: {
  hexes: Hex[]; margin: number; rotation: number;
}) {
  const { cx, cy, R } = regularHexFrame(hexes, margin);

  const hexByKey = new Map(hexes.map(h => [`${h.q},${h.r}`, h] as const));

  // 10 segment labels going CW between the 10 break points. Each main "5-edge"
  // side has a distinct label 1-6; the 4 "2-edge" extensions share the label
  // of the main side they trail (so split sides read as pairs: "2,2" "3,3"
  // "5,5" "6,6"). Sequence matches BREAK_LAND_CORNERS_EXPANSION order:
  //   4 (top main) → 5 (TR main) | 5 (TR ext) → 6 (R main) | 6 (R ext) →
  //   1 (bottom main) → 2 (BL main) | 2 (BL ext) → 3 (L main) | 3 (L ext).
  // i.e. labels[i] is the SEGMENT ENDING AT break i in CW order.
  const segmentLabels = [4, 5, 5, 6, 6, 1, 2, 2, 3, 3];

  // First pass: compute each break's land-corner anchor + the outer endpoint
  // where its seam meets the frame outline. Project radially from the bbox
  // center so the seam always reaches the border (and slightly past, for
  // visual cleanness against the dark frame stroke).
  type Break = { angle: number; landX: number; landY: number; outerX: number; outerY: number };
  const breaks: Break[] = [];
  for (const spec of BREAK_LAND_CORNERS_EXPANSION) {
    const hex = hexByKey.get(`${spec.q},${spec.r}`);
    if (!hex) continue;
    const c = hexCorner(hex, spec.corner);
    const angle = Math.atan2(c.y - cy, c.x - cx);
    const onFrame = rayToFlatTopHex(angle, R);
    breaks.push({
      angle,
      landX: c.x,
      landY: c.y,
      outerX: cx + onFrame.x,
      outerY: cy + onFrame.y,
    });
  }
  if (breaks.length !== BREAK_LAND_CORNERS_EXPANSION.length) return null;

  const elems: JSX.Element[] = [];

  // Each break: seam line from land corner outward to the frame border, with
  // a numbered badge sitting on the outer end of the seam itself (not on the
  // adjacent section). Label = the segment that ENDS at this break, so two
  // breaks bracketing a split side read as the same number twice (the "2,2"
  // and "5,5" pairs the user described).
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i];
    const d = puzzleBreakPath(b.landX, b.landY, b.outerX, b.outerY);
    // Label sits ON the frame edge at the seam's outer endpoint so it reads
    // as a "wax seal" stamped at the joint between two frame pieces — the
    // dark frame stroke passes through the badge's center.
    const lx = b.outerX;
    const ly = b.outerY;
    const label = segmentLabels[i];
    elems.push(
      <g key={`seam-${i}`}>
        <path d={d} fill="none" stroke="#a9d6ec" strokeWidth={0.10} strokeLinecap="round" opacity={0.5} />
        <path d={d} fill="none" stroke="#1f4666" strokeWidth={0.055} strokeLinecap="round" />
        <g transform={`translate(${lx} ${ly}) rotate(${-rotation})`}>
          <circle r={0.24} fill="#f4e4bc" stroke="#5d462a" strokeWidth={0.025} />
          <text
            x={0} y={0} dy={0.098}
            textAnchor="middle"
            fontSize={0.28} fontWeight={900} fill="#5d462a"
          >
            {label}
          </text>
        </g>
      </g>,
    );
  }

  return <>{elems}</>;
}

// ---------------------------------------------------------------------------
// (Old corner-bump extension component removed — the user's reference shows
//  seam LINES from perimeter edges, not bumps from side midpoints. See
//  FrameSeamsExpansion above for the new implementation.)
// ---------------------------------------------------------------------------


function pipDots(n: number, cx: number, cy: number): JSX.Element[] {
  const count = PIP_VALUE[n] ?? 0;
  const spacing = 0.05;
  const startX = cx - ((count - 1) * spacing) / 2;
  const y = cy + 0.20;
  const isRed = RED_NUMBERS.has(n);
  return Array.from({ length: count }, (_, i) => (
    <circle
      key={i}
      className={isRed ? 'pip-dot pip-dot--red' : 'pip-dot'}
      cx={startX + i * spacing}
      cy={y}
      r={0.022}
    />
  ));
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 3;
const RESET = { x: 0, y: 0, scale: 1 } as const;

export function Board() {
  const map = useAppStore(s => s.map);
  const scored = useAppStore(s => s.scored);
  const showBestLocations = useAppStore(s => s.showBestLocations);
  const waterFrame = useAppStore(s => s.waterFrame);
  const rotation = useAppStore(s => s.rotation);
  const rotateBy = useAppStore(s => s.rotateBy);
  const resetRotation = useAppStore(s => s.resetRotation);

  // Pan/zoom uses a hybrid path: CSS transform on the outer <svg> *during* an
  // active gesture (fast bitmap composite — fine for transient blur), then
  // SVG-native transform on an inner <g> *after* the gesture ends (sharp
  // vector at the resting zoom level). The transition is invisible because
  // the math represents the same view in both modes. iOS Safari otherwise
  // keeps a stretched bitmap of the SVG layer after CSS transform — which is
  // exactly the "still blurry when zoomed in and idle" complaint we saw.
  //
  // viewRef stores x, y, scale in SVG user units (NOT pixels), so the same
  // numbers map cleanly into both transform spaces. Drag deltas come from
  // useGesture in pixels and are converted via pxPerUnit().
  const viewRef = useRef<{ x: number; y: number; scale: number }>({ ...RESET });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panZoomRef = useRef<SVGGElement>(null);
  // Cached container bounds. getBoundingClientRect() can trigger a forced
  // layout flush, so we measure once on mount + on resize and reuse it.
  const boundsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  // rAF tokens for coalescing high-frequency events. Some precision pointer
  // devices fire pointermove > 120Hz; coalescing into one transform write
  // per frame prevents main-thread saturation.
  const wheelRafRef = useRef<number | null>(null);
  const wheelIdleRef = useRef<number | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const pinchRafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      boundsRef.current = { width: rect.width, height: rect.height };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { viewBox, boardCx, boardCy, viewBoxR } = useMemo(() => {
    if (!map) return { viewBox: '-6 -6 12 12', boardCx: 0, boardCy: 0, viewBoxR: 6 };
    // Square viewBox centered on the board, sized to contain the water frame
    // (regular hex circumradius R) plus any port docks that reach beyond it
    // on coastal sides. (cx, cy) is also returned so the rotation transform
    // below can pivot around the BOARD's bbox center — for the 5-6 expansion
    // the staggered rows shift the land off (0,0). viewBoxR (= R) is used by
    // the gesture math to convert pixel deltas to SVG user units.
    const { cx, cy, landR, R: frameR } = regularHexFrame(map.hexes, FRAME_MARGIN);
    const portReach = 1.5;
    const stroke = 0.3;
    const R = Math.max(frameR, landR + portReach) + stroke;
    return {
      viewBox: `${(cx - R).toFixed(2)} ${(cy - R).toFixed(2)} ${(2 * R).toFixed(2)} ${(2 * R).toFixed(2)}`,
      boardCx: cx,
      boardCy: cy,
      viewBoxR: R,
    };
  }, [map]);

  // Pixels-per-user-unit at the current container size. preserveAspectRatio
  // "xMidYMid meet" fits the viewBox to the SMALLER dimension of the container,
  // so min(w, h) is the relevant scale factor.
  const px2unit = useCallback(() => {
    const { width, height } = boundsRef.current;
    if (!width || !height) return 1;
    return Math.min(width, height) / (2 * viewBoxR);
  }, [viewBoxR]);

  // Clamp in SVG user units. Allows panning up to ±R*scale in each axis,
  // which keeps at least half the board on screen at any zoom level.
  const clamp = useCallback((next: { x: number; y: number; scale: number }) => {
    const max = viewBoxR * next.scale;
    return {
      scale: next.scale,
      x: Math.max(-max, Math.min(max, next.x)),
      y: Math.max(-max, Math.min(max, next.y)),
    };
  }, [viewBoxR]);

  // CSS transform on the outer <svg>. Fast bitmap composite, used during an
  // active gesture. Panning is in pixels here (CSS unit), so multiply x/y
  // (stored in SVG user units) by pxPerUnit.
  const applyCSSTransform = useCallback((next: { x: number; y: number; scale: number }) => {
    viewRef.current = next;
    const svg = svgRef.current;
    if (!svg) return;
    const k = px2unit();
    svg.style.transform = `translate3d(${next.x * k}px, ${next.y * k}px, 0) scale(${next.scale})`;
  }, [px2unit]);

  // SVG-native transform on the inner <g>. Vector re-render — sharp at any
  // zoom. Used after a gesture ends (one-time write, not per-frame).
  // Scale pivots around the viewBox center (boardCx, boardCy) to match the
  // CSS transform's `transform-origin: center center` behavior.
  const applySVGTransform = useCallback((next: { x: number; y: number; scale: number }) => {
    viewRef.current = next;
    const g = panZoomRef.current;
    if (!g) return;
    if (next.x === 0 && next.y === 0 && next.scale === 1) {
      g.removeAttribute('transform');
    } else {
      const tx = next.x + boardCx * (1 - next.scale);
      const ty = next.y + boardCy * (1 - next.scale);
      g.setAttribute('transform', `matrix(${next.scale} 0 0 ${next.scale} ${tx} ${ty})`);
    }
  }, [boardCx, boardCy]);

  // Switch from SVG-mode (resting) to CSS-mode (active gesture). Clear the
  // inner <g>'s transform and write the equivalent CSS transform on the
  // <svg>. The browser batches both writes so the visual position is
  // identical across the swap — no jump for the user.
  const enterCSSMode = useCallback(() => {
    if (panZoomRef.current) panZoomRef.current.removeAttribute('transform');
    if (svgRef.current) svgRef.current.style.willChange = 'transform';
    applyCSSTransform(viewRef.current);
  }, [applyCSSTransform]);

  // Switch from CSS-mode (active gesture) back to SVG-mode (resting). Clear
  // the <svg>'s CSS transform, apply the equivalent SVG transform on the
  // inner <g>. Same atomicity / no-jump guarantee.
  const exitCSSMode = useCallback(() => {
    const svg = svgRef.current;
    if (svg) {
      svg.style.transform = '';
      svg.style.willChange = '';
    }
    applySVGTransform(viewRef.current);
  }, [applySVGTransform]);

  useGesture(
    {
      onDrag: ({ delta: [dxPx, dyPx], first, last }) => {
        const k = px2unit();
        if (k <= 0) return;
        if (first) enterCSSMode();
        const cur = viewRef.current;
        // Convert finger pixel delta → SVG-unit delta so the math stays
        // consistent across the CSS ↔ SVG transform swap at gesture end.
        viewRef.current = { ...cur, x: cur.x + dxPx / k, y: cur.y + dyPx / k };
        if (dragRafRef.current == null) {
          dragRafRef.current = window.requestAnimationFrame(() => {
            dragRafRef.current = null;
            applyCSSTransform(clamp(viewRef.current));
          });
        }
        if (last) {
          if (dragRafRef.current != null) {
            window.cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = null;
          }
          viewRef.current = clamp(viewRef.current);
          exitCSSMode();
        }
      },
      onPinch: ({ offset: [s], first, last }) => {
        if (first) enterCSSMode();
        const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
        viewRef.current = { ...viewRef.current, scale };
        if (pinchRafRef.current == null) {
          pinchRafRef.current = window.requestAnimationFrame(() => {
            pinchRafRef.current = null;
            applyCSSTransform(clamp(viewRef.current));
          });
        }
        if (last) {
          if (pinchRafRef.current != null) {
            window.cancelAnimationFrame(pinchRafRef.current);
            pinchRafRef.current = null;
          }
          viewRef.current = clamp(viewRef.current);
          exitCSSMode();
        }
      },
      onWheel: ({ event, delta: [, dy] }) => {
        event.preventDefault();
        // First wheel tick after idle → enter CSS mode. The idle timer below
        // will bounce us back to SVG mode ~200ms after the last tick.
        if (wheelIdleRef.current == null) enterCSSMode();
        const cur = viewRef.current;
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.scale - dy * 0.002));
        viewRef.current = { ...cur, scale: nextScale };
        if (wheelRafRef.current == null) {
          wheelRafRef.current = window.requestAnimationFrame(() => {
            wheelRafRef.current = null;
            applyCSSTransform(clamp(viewRef.current));
          });
        }
        if (wheelIdleRef.current != null) window.clearTimeout(wheelIdleRef.current);
        wheelIdleRef.current = window.setTimeout(() => {
          wheelIdleRef.current = null;
          if (wheelRafRef.current != null) {
            window.cancelAnimationFrame(wheelRafRef.current);
            wheelRafRef.current = null;
          }
          viewRef.current = clamp(viewRef.current);
          exitCSSMode();
        }, 200);
      },
      onDoubleClick: () => {
        // Cancel any in-flight gesture state and snap to identity in SVG mode.
        if (svgRef.current) {
          svgRef.current.style.transform = '';
          svgRef.current.style.willChange = '';
        }
        applySVGTransform({ ...RESET });
      },
    },
    {
      target: containerRef,
      eventOptions: { passive: false },
    },
  );

  // The "top N" highlighted spots in the Analyze overlay come from the actual
  // snake-draft simulation (`scored.fairness.picks`) rather than just sorting
  // every intersection by score. The simulator already enforces the distance-2
  // rule between settlements, so we never highlight a clump of physically
  // impossible adjacent picks.
  const topNRanked = useMemo(() => {
    if (!scored || !showBestLocations) return [];
    return scored.fairness.picks
      .map(p => scored.spots.get(p.intersectionId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
  }, [scored, showBestLocations]);

  if (!map || !scored) {
    return <div className="app__board" ref={containerRef} />;
  }

  return (
    <div className="app__board" ref={containerRef}>
      <svg
        ref={svgRef}
        className="board-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {/* Per-resource fill gradients add a subtle painted/depth feel
              compared to flat fills. */}
          <radialGradient id="grad-wood" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#3d8a48" />
            <stop offset="100%" stopColor="#1f5028" />
          </radialGradient>
          <radialGradient id="grad-brick" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#c2543a" />
            <stop offset="100%" stopColor="#7a2510" />
          </radialGradient>
          <radialGradient id="grad-wheat" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#f0d273" />
            <stop offset="100%" stopColor="#b88d28" />
          </radialGradient>
          <radialGradient id="grad-sheep" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#b3dca0" />
            <stop offset="100%" stopColor="#6da655" />
          </radialGradient>
          <radialGradient id="grad-ore" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#878d9b" />
            <stop offset="100%" stopColor="#3f4654" />
          </radialGradient>
          <radialGradient id="grad-desert" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#ecd49a" />
            <stop offset="100%" stopColor="#b6914f" />
          </radialGradient>
          <radialGradient id="grad-sea" cx="50%" cy="50%" r="65%">
            <stop offset="0%" stopColor="#5fb1d8" />
            <stop offset="60%" stopColor="#3f8fc0" />
            <stop offset="100%" stopColor="#26628b" />
          </radialGradient>
          {/* Unit pointy-top hex (circumradius 1) centered at origin. Every
              TileArt wraps its scene with this clip-path so art elements
              (cloud silhouettes, hill paths, sheep, etc.) can never bleed
              past the hex boundary into neighbouring tiles or the sea. */}
          <clipPath id="hex-clip">
            <polygon points="0,-1 0.8660,-0.5 0.8660,0.5 0,1 -0.8660,0.5 -0.8660,-0.5" />
          </clipPath>
        </defs>

        {/* Pan/zoom group — its `transform` attribute is set imperatively by
            exitCSSMode() after a gesture ends, giving sharp vector rendering
            at the resting zoom level. During an active gesture this group's
            transform is empty and pan/zoom is applied via CSS transform on
            the outer <svg> instead (fast bitmap composite). */}
        <g ref={panZoomRef}>
        {/* Rotation wraps the whole board (water frame + land + ports + analyze)
            so everything spins together. Pivots around the board's bbox center
            (boardCx, boardCy) so the 5-6 expansion's off-origin layout still
            stays in the viewBox under rotation. */}
        <g transform={`rotate(${rotation} ${boardCx} ${boardCy})`}>
          {/* Water frame — a sea-colored hex that sits below the land so ports
              and docks read as floating in water instead of on the red page.
              Pure visual: toggled in the controls, NOT persisted in the map. */}
          {waterFrame && (
            // No filter on this group — at 4K the water-frame filter region
            // ends up ~4000x4000px, and every transform change forces the
            // browser to re-rasterize the filtered sub-tree (or composite a
            // very large filter buffer). The drop shadow is subtle enough
            // that the loss isn't noticeable.
            <g>
              <defs>
                <clipPath id="sea-clip">
                  <path d={seaFramePath(map.hexes, FRAME_MARGIN)} />
                </clipPath>
              </defs>
              <path
                d={seaFramePath(map.hexes, FRAME_MARGIN)}
                fill="url(#grad-sea)"
                stroke="#1f4666"
                strokeWidth={0.06}
              />
              {/* Wave highlights, clipped to the sea hexagon so nothing leaks
                  into the page background. */}
              <g
                clipPath="url(#sea-clip)"
                stroke="#a9d6ec"
                strokeWidth={0.025}
                strokeLinecap="round"
                opacity={0.55}
                fill="none"
              >
                {(() => {
                  const { minX, maxX, minY, maxY } = boundingBox(map.hexes);
                  const lines: JSX.Element[] = [];
                  const left = minX - 2.0;
                  const right = maxX + 2.0;
                  for (let y = minY - 2.0; y <= maxY + 2.0; y += 0.45) {
                    const offset = (Math.sin(y * 3.1) + 1) * 0.15;
                    const segs = Math.ceil((right - left) / 0.5);
                    let d = `M ${(left + offset).toFixed(3)},${y.toFixed(3)} q 0.25,-0.08 0.5,0`;
                    for (let i = 1; i < segs; i++) d += ' t 0.5,0';
                    lines.push(<path key={`wave-${y.toFixed(2)}`} d={d} />);
                  }
                  return lines;
                })()}
              </g>
            </g>
          )}

          {/* Continuous beach band — the land perimeter is traced as a single
              closed polygon and stroked thick with sandy tones. The inner half
              of each stroke is hidden under the tile fills below; the outer
              half forms a wide visible beach where the docks attach. Two
              layered strokes give a soft outer fade + denser inner core. */}
          {(() => {
            const edges = perimeterEdgesCW(map.hexes);
            if (edges.length === 0) return null;
            const hexById = new Map(map.hexes.map(h => [h.id, h]));
            const pts: string[] = [];
            for (const e of edges) {
              const hex = hexById.get(e.hexId);
              if (!hex) continue;
              const c = hexCorner(hex, e.side);
              pts.push(`${c.x.toFixed(3)},${c.y.toFixed(3)}`);
            }
            const d = `M${pts.join(' L')} Z`;
            return (
              <g>
                <path d={d} fill="none" stroke="#e8c98a" strokeWidth={0.62} strokeLinejoin="round" strokeLinecap="round" opacity={0.65} />
                <path d={d} fill="none" stroke="#d6a861" strokeWidth={0.34} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
              </g>
            );
          })()}

          {/* Puzzle-piece seam breaks render ABOVE the beach so the seam lines
              and section-number badges sit on top of the sandy band, not
              hidden underneath. 6 breaks for base (FrameCorners) or 10 for the
              5-6 expansion (FrameSeamsExpansion). Pattern: base 5-5-5-5-5-5,
              expansion 5-2-5-5-2-5-2-5-5-2. */}
          {waterFrame && (
            map.playerCount <= 4 ? (
              <FrameCorners hexes={map.hexes} margin={FRAME_MARGIN} rotation={rotation} />
            ) : (
              <FrameSeamsExpansion hexes={map.hexes} margin={FRAME_MARGIN} rotation={rotation} />
            )
          )}

          {/* Tile fills */}
          {map.hexes.map(h => (
            <path
              key={h.id}
              d={hexPath(h)}
              fill={`url(#grad-${h.resource})`}
              stroke="#3a2916"
              strokeWidth={0.04}
            />
          ))}

          {/* Resource artwork — fills most of the hex. Each scene counter-rotates
              so the trees / sheep / mountains stay upright as the board spins. */}
          {map.hexes.map(h => {
            const { x, y } = axialToPixel({ q: h.q, r: h.r });
            return <TileArt key={`art-${h.id}`} resource={h.resource} cx={x} cy={y} rotation={rotation} />;
          })}

          {/* Number tokens — placed AT the tile center (not offset) so they
              stay aligned with the resource artwork beneath them under any
              rotation. The inner counter-rotation keeps the digit + pip dots
              right-side-up for the viewer. */}
          {map.hexes.map(h => {
            if (h.number === null) return null;
            const { x, y } = axialToPixel({ q: h.q, r: h.r });
            const isRed = RED_NUMBERS.has(h.number);
            return (
              <g key={`n-${h.id}`} transform={`translate(${x} ${y}) rotate(${-rotation})`}>
                <circle
                  cx={0} cy={0} r={0.36}
                  className={isRed ? 'number-token number-token--red' : 'number-token'}
                />
                <circle
                  cx={0} cy={0} r={0.31}
                  fill="none" stroke="#9c7a3d" strokeWidth={0.012} opacity={0.7}
                />
                <text
                  x={0} y={-0.05} dy={0.119}
                  className={isRed ? 'number-text number-text--red' : 'number-text'}
                  fontSize={0.34}
                >
                  {h.number}
                </text>
                {pipDots(h.number, 0, 0)}
              </g>
            );
          })}

          {/* Ports */}
          {map.ports.map((p, idx) => (
            <PortMark key={`p-${idx}`} port={p} hexes={map.hexes} rotation={rotation} />
          ))}

          {showBestLocations && topNRanked.length > 0 && (
            <g>
              {Array.from(scored.spots.values()).map(spot => {
                const inter = scored.graph.intersections.get(spot.intersectionId)!;
                const rank = topNRanked.findIndex(s => s.intersectionId === spot.intersectionId);
                if (rank === -1) {
                  return (
                    <g key={`badge-${inter.id}`} transform={`translate(${inter.x} ${inter.y}) rotate(${-rotation})`}>
                      <circle className="spot-badge" cx={0} cy={0} r={0.18} opacity={0.65} />
                      <text className="spot-text" x={0} y={0} dy={0.077}>
                        {spot.total.toFixed(1)}
                      </text>
                    </g>
                  );
                }
                return (
                  <g key={`rank-${inter.id}`} transform={`translate(${inter.x} ${inter.y}) rotate(${-rotation})`}>
                    <circle className="spot-rank" cx={0} cy={0} r={0.28} />
                    <circle className="spot-badge" cx={0} cy={0} r={0.22} />
                    <text className="spot-rank-text" x={0} y={-0.04} dy={0.077}>
                      {rank + 1}
                    </text>
                    <text className="spot-text" x={0} y={0.13} dy={0.056} fontSize={0.16}>
                      {spot.total.toFixed(1)}
                    </text>
                  </g>
                );
              })}
              {Array.from(scored.spots.values())
                .filter(s => s.hasRoadCombo || s.hasCityCombo)
                .map(s => {
                  const inter = scored.graph.intersections.get(s.intersectionId)!;
                  const icon = s.hasCityCombo ? '♔' : '⚒';
                  return (
                    <text
                      key={`syn-${s.intersectionId}`}
                      className="synergy-icon"
                      dy={0.077}
                      transform={`translate(${inter.x + 0.32} ${inter.y - 0.32}) rotate(${-rotation})`}
                    >
                      {icon}
                    </text>
                  );
                })}
            </g>
          )}

        </g>
        </g>
      </svg>
      <div className="board__view-controls">
        <button
          className="board__btn"
          onClick={() => rotateBy(-30)}
          aria-label="Rotate counter-clockwise"
          title="Rotate 30° counter-clockwise"
        >
          ↺
        </button>
        <button
          className="board__btn board__btn--label"
          onClick={resetRotation}
          aria-label="Reset rotation"
          title="Reset rotation"
        >
          {rotation}°
        </button>
        <button
          className="board__btn"
          onClick={() => rotateBy(30)}
          aria-label="Rotate clockwise"
          title="Rotate 30° clockwise"
        >
          ↻
        </button>
        <button
          className="board__btn"
          onClick={() => {
            if (svgRef.current) {
              svgRef.current.style.transform = '';
              svgRef.current.style.willChange = '';
            }
            applySVGTransform({ ...RESET });
          }}
          aria-label="Reset pan and zoom"
          title="Reset pan/zoom (or double-tap board)"
        >
          ⟲
        </button>
      </div>
    </div>
  );
}

// 6 land-hex corners where the canonical 5th-edition sea frame pieces meet.
// Each break sits at the corner of a corner-hex of the overall board, at
// every 5th perimeter edge (30 edges / 6 pieces). Currently base-game only.
//
// Positions are shifted one perimeter edge CCW from the original "right edge
// of the bottom-left port" anchor: each corner is now the one immediately
// before its previous position in CW traversal.
const BREAK_LAND_CORNERS_BASE: Array<{ q: number; r: number; corner: number }> = [
  { q: -2, r:  2, corner: 3 },  // bottom of bottom-left corner-hex
  { q: -2, r:  0, corner: 4 },  // bottom-left of left-middle corner-hex
  { q:  0, r: -2, corner: 5 },  // top-left of top-left corner-hex
  { q:  2, r: -2, corner: 0 },  // top of top-right corner-hex
  { q:  2, r:  0, corner: 1 },  // top-right of right-middle corner-hex
  { q:  0, r:  2, corner: 2 },  // bottom-right of bottom-right corner-hex
];

// SVG path for a puzzle-piece break: an S-shaped wavy line from the inner
// anchor (land corner) outward to the outer anchor (water frame perimeter),
// with a small interlock bump in the middle that reads as two pieces meeting.
function puzzleBreakPath(innerX: number, innerY: number, outerX: number, outerY: number): string {
  const dx = outerX - innerX;
  const dy = outerY - innerY;
  const len = Math.hypot(dx, dy) || 1;
  // Tangent perpendicular to the radial direction (along the perimeter).
  const tx = -dy / len;
  const ty = dx / len;
  const bump = Math.min(0.22, len * 0.25);
  // Two quadratic curves with opposite-side controls produce a clean S-curve;
  // the user's reference sketch is essentially a single sine-wave seam.
  const pt = (t: number, perp: number) => ({
    x: innerX + dx * t + tx * perp,
    y: innerY + dy * t + ty * perp,
  });
  const mid = pt(0.50, 0);
  const c1 = pt(0.28, bump);
  const c2 = pt(0.72, -bump);
  return (
    `M ${innerX.toFixed(3)},${innerY.toFixed(3)}` +
    ` Q ${c1.x.toFixed(3)},${c1.y.toFixed(3)} ${mid.x.toFixed(3)},${mid.y.toFixed(3)}` +
    ` Q ${c2.x.toFixed(3)},${c2.y.toFixed(3)} ${outerX.toFixed(3)},${outerY.toFixed(3)}`
  );
}

function FrameCorners({ hexes, margin, rotation }: { hexes: Hex[]; margin: number; rotation: number }) {
  const { cx, cy, R } = regularHexFrame(hexes, margin);
  const hexByKey = new Map(hexes.map(h => [`${h.q},${h.r}`, h] as const));
  const breaks = BREAK_LAND_CORNERS_BASE.map(spec => {
    const hex = hexByKey.get(`${spec.q},${spec.r}`);
    if (!hex) return null;
    const corner = hexCorner(hex, spec.corner);
    const angle = Math.atan2(corner.y - cy, corner.x - cx);
    return { angle, landX: corner.x, landY: corner.y };
  }).filter((b): b is { angle: number; landX: number; landY: number } => b !== null);

  if (breaks.length !== 6) return null;

  // Sort CCW (increasing angle, normalized to [0, 2π)).
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sorted = breaks.slice().sort((a, b) => norm(a.angle) - norm(b.angle));

  const elems: JSX.Element[] = [];

  // Puzzle-piece seams + numbered break labels. Each one is a wavy line from
  // the land hex corner outward through the water to the outer edge of the
  // frame, with a section number badge sitting on the outer end of the seam.
  // Labels go 1..6 CW starting from the break in the bottom area (closest to
  // SVG +y), matching the user's reference layout.
  for (let i = 0; i < 6; i++) {
    const b = sorted[i];
    const proj = rayToFlatTopHex(b.angle, R);
    const outerX = cx + proj.x;
    const outerY = cy + proj.y;
    const d = puzzleBreakPath(b.landX, b.landY, outerX, outerY);
    const label = i + 1;
    // Label sits ON the frame edge at the seam's outer endpoint — the dark
    // frame stroke passes through the badge so it reads as a "wax seal"
    // stamped at each piece-to-piece joint.
    const lx = outerX;
    const ly = outerY;
    elems.push(
      <g key={`break-${i}`}>
        {/* Light highlight halo so the seam stays visible against any sea tone */}
        <path d={d} fill="none" stroke="#a9d6ec" strokeWidth={0.10} strokeLinecap="round" opacity={0.5} />
        {/* Main seam line */}
        <path d={d} fill="none" stroke="#1f4666" strokeWidth={0.055} strokeLinecap="round" />
        {/* Numbered badge sitting on the outer end of the seam */}
        <g transform={`translate(${lx} ${ly}) rotate(${-rotation})`}>
          <circle r={0.26} fill="#f4e4bc" stroke="#5d462a" strokeWidth={0.03} />
          <text
            x={0} y={0} dy={0.112}
            textAnchor="middle"
            fontSize={0.32}
            fontWeight={900}
            fill="#5d462a"
          >
            {label}
          </text>
        </g>
      </g>,
    );
  }

  return <>{elems}</>;
}

function PortMark({ port, hexes, rotation }: { port: Port; hexes: Hex[]; rotation: number }) {
  const hex = hexes.find(h => h.id === port.hexId);
  if (!hex) return null;
  const a = hexCorner(hex, port.side);
  const b = hexCorner(hex, (port.side + 1) % 6);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const center = axialToPixel({ q: hex.q, r: hex.r });
  const dx = mid.x - center.x;
  const dy = mid.y - center.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  // Outward unit vector (perpendicular to the coastal edge, pointing to sea)
  const ux = dx / dist;
  const uy = dy / dist;
  // Perpendicular along the edge (used to widen the planking)
  const px = -uy;
  const py = ux;

  const dockLen = 0.65;
  const dockHalfWidth = 0.22;
  const baseA = { x: mid.x + px * dockHalfWidth, y: mid.y + py * dockHalfWidth };
  const baseB = { x: mid.x - px * dockHalfWidth, y: mid.y - py * dockHalfWidth };
  const endMid = { x: mid.x + ux * dockLen, y: mid.y + uy * dockLen };
  const endA = { x: endMid.x + px * dockHalfWidth, y: endMid.y + py * dockHalfWidth };
  const endB = { x: endMid.x - px * dockHalfWidth, y: endMid.y - py * dockHalfWidth };

  const plankPath = `M ${baseA.x.toFixed(3)},${baseA.y.toFixed(3)} L ${endA.x.toFixed(3)},${endA.y.toFixed(3)} L ${endB.x.toFixed(3)},${endB.y.toFixed(3)} L ${baseB.x.toFixed(3)},${baseB.y.toFixed(3)} Z`;

  // Three transverse plank lines across the dock surface
  const plankLines = [0.25, 0.5, 0.75].map(t => {
    const ax = baseA.x + (endA.x - baseA.x) * t;
    const ay = baseA.y + (endA.y - baseA.y) * t;
    const bx = baseB.x + (endB.x - baseB.x) * t;
    const by = baseB.y + (endB.y - baseB.y) * t;
    return { ax, ay, bx, by, t };
  });

  // Platform at the seaward end where the resource sign sits
  const platformCx = mid.x + ux * (dockLen + 0.18);
  const platformCy = mid.y + uy * (dockLen + 0.18);

  const label = port.type === 'generic' ? '3:1' : '2:1';

  return (
    <g>
      {/* Tethering ropes from the hex coast corners to the platform */}
      <line className="port-rope" x1={a.x} y1={a.y} x2={platformCx} y2={platformCy} />
      <line className="port-rope" x1={b.x} y1={b.y} x2={platformCx} y2={platformCy} />

      {/* Dock planking */}
      <path d={plankPath} fill="#9c6a32" stroke="#3a2510" strokeWidth={0.018} />
      {plankLines.map((p, i) => (
        <line
          key={i}
          x1={p.ax}
          y1={p.ay}
          x2={p.bx}
          y2={p.by}
          stroke="#5d3a18"
          strokeWidth={0.018}
        />
      ))}
      {/* Posts at the dock's seaward corners */}
      <circle cx={endA.x} cy={endA.y} r={0.045} fill="#5d3a18" stroke="#2a1808" strokeWidth={0.015} />
      <circle cx={endB.x} cy={endB.y} r={0.045} fill="#5d3a18" stroke="#2a1808" strokeWidth={0.015} />

      {/* Resource sign / chip sitting at the end of the dock */}
      <circle
        cx={platformCx}
        cy={platformCy}
        r={0.32}
        fill={port.type === 'generic' ? '#f4e4bc' : `url(#grad-${port.type})`}
        stroke="#3a2916"
        strokeWidth={0.025}
      />
      <circle
        cx={platformCx}
        cy={platformCy}
        r={0.27}
        fill="none"
        stroke="#9c7a3d"
        strokeWidth={0.012}
        opacity={0.7}
      />
      {/* Glyph + ratio ribbon counter-rotate around the platform so they
          stay readable for the viewer regardless of board rotation. */}
      <g transform={`translate(${platformCx} ${platformCy}) rotate(${-rotation})`}>
        <g transform="translate(0 -0.04)">
          <PortGlyph type={port.type} size={0.85} />
        </g>
        <rect
          x={-0.16} y={0.20} width={0.32} height={0.16} rx={0.04}
          fill="#f4e4bc" stroke="#5d462a" strokeWidth={0.018}
        />
        <text
          x={0} y={0.285} dy={0.046}
          textAnchor="middle"
          fontSize={0.13} fontWeight={900} fill="#5d462a"
        >
          {label}
        </text>
      </g>
    </g>
  );
}
