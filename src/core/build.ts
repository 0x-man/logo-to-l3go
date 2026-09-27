// Logo grid -> a standing brick sign you can build (Mini or XL).
//
// Units: x and z in studs (x to the right, z towards the back, z = 0 is the
// front face), y in plates. One logo pixel is one stud wide (XL: 2×2 studs)
// and one "row" tall: Mini rows alternate one brick and two plates (2.5
// plates on average ≈ one stud, so pixels stay square); XL rows are a brick
// and two plates (5 plates = 2 studs).
import { checkModel, connections, grounded, type Checks } from './check';
import type { LogoGrid } from './logo';
import { BASE_GRAY, BLACK, COLOR_BY_ID, TRANS_CLEAR } from './palette';
import { partId, partName, SIZES, TILE_SIZES, type Kind, type Piece } from './parts';
import { key, kx, kz, tileLayer, type Layer, type TileOpts } from './tile';
import { availableAtLego } from './lego';
import { rgbToLab, deltaE } from './color';

export type SizeId = 'mini' | 'xl';
export type Style = 'panel' | 'cutout';

export interface SizeSpec {
  id: SizeId;
  sx: number;               // studs per pixel
  relief: number;           // how far the logo stands out of the panel, studs
  panel: number;            // panel thickness, studs
  cutout: number;           // logo thickness without a panel, studs
  margin: number;           // panel border around the logo, pixels
  rowLayers: { kind: Kind; h: number }[];
  rowLayersAlt?: { kind: Kind; h: number }[];
  baseLayers: { kind: Kind; h: number }[];
  baseMargin: { side: number; front: number; back: number };
  cantilever: number;       // longest overhang (studs) before a clear support column is added
  nameplate: [number, number] | null;
}

export const SIZES_SPEC: Record<SizeId, SizeSpec> = {
  mini: {
    id: 'mini', sx: 1, relief: 1, panel: 2, cutout: 2, margin: 1,
    rowLayers: [{ kind: 'brick', h: 3 }], rowLayersAlt: [{ kind: 'plate', h: 1 }, { kind: 'plate', h: 1 }],
    baseLayers: [{ kind: 'plate', h: 1 }, { kind: 'plate', h: 1 }],
    baseMargin: { side: 1, front: 3, back: 2 }, cantilever: 6, nameplate: [6, 1],
  },
  xl: {
    id: 'xl', sx: 2, relief: 2, panel: 3, cutout: 4, margin: 1,
    rowLayers: [{ kind: 'brick', h: 3 }, { kind: 'plate', h: 1 }, { kind: 'plate', h: 1 }],
    baseLayers: [{ kind: 'brick', h: 3 }, { kind: 'plate', h: 1 }],
    baseMargin: { side: 2, front: 5, back: 3 }, cantilever: 12, nameplate: [6, 2],
  },
};

export interface BuildOptions {
  style?: Style;
  /** BrickLink colour of the panel; 'auto' picks the logo's own background or a contrasting colour */
  panelColor?: number | 'auto';
  /** only use parts LEGO sells (Pick a Brick), splitting the others into smaller ones */
  preferLego?: boolean;
}

export interface BomLine { part: string; kind: Kind; name: string; color: number; colorName: string; hex: string; w: number; d: number; qty: number }

export interface Model {
  size: SizeId;
  style: Style;
  panelColor: number | null;
  pieces: Piece[];
  steps: number[][];
  bom: BomLine[];
  colors: Record<number, string>;
  checks: Checks;
  notes: string[];
  /** approximate size in cm: width, depth, height */
  dims: [number, number, number];
}

interface LayerRec { y: number; h: number; kind: Kind; cells: Layer; row: number | null; pieces: Piece[] }

/** Panel colour when left on auto: the logo's flat background, else white or black, whichever contrasts more. */
export function autoPanelColor(g: LogoGrid): number {
  if (g.background) {
    const lab = rgbToLab(g.background);
    let best = 1, bd = Infinity;
    for (const c of COLOR_BY_ID.values()) {
      if (c.trans) continue;
      const [r, gg, b] = [1, 3, 5].map(i => parseInt(c.hex.slice(i, i + 2), 16));
      const d = deltaE(lab, rgbToLab([r, gg, b]));
      if (d < bd) { bd = d; best = c.id; }
    }
    return best;
  }
  let L = 0, n = 0;
  for (const c of g.colors) { L += rgbToLab(c.rgb)[0] * c.count; n += c.count; }
  return n && L / n > 62 ? BLACK : 1;   // light logo: black panel; otherwise white
}

export function buildModel(grid: LogoGrid, size: SizeId, o: BuildOptions & Partial<SizeSpec> = {}): Model {
  const S = { ...SIZES_SPEC[size], ...o };
  const style: Style = o.style ?? 'panel';
  const allow = o.preferLego ? availableAtLego : undefined;
  const notes: string[] = [];
  const { sx } = S;
  const panelColor = style === 'panel' ? (o.panelColor === undefined || o.panelColor === 'auto' ? autoPanelColor(grid) : o.panelColor) : null;
  const m = style === 'panel' ? S.margin : 0;
  const D = style === 'panel' ? S.relief + S.panel : S.cutout;

  // ---------- 1. pixels -> stud cells, one map per pixel row (row 0 = top) ----------
  const R = grid.h + 2 * m, C = grid.w + 2 * m;
  const logoAt = (r: number, c: number) => {
    const rr = r - m, cc = c - m;
    if (rr < 0 || cc < 0 || rr >= grid.h || cc >= grid.w) return -1;
    const v = grid.cells[rr][cc];
    return v < 0 ? -1 : grid.colors[v].brick;
  };
  const rowCells = new Map<number, Map<number, number>>();
  for (let r = 0; r < R; r++) {
    const cells = new Map<number, number>();
    for (let c = 0; c < C; c++) {
      const b = logoAt(r, c);
      const corner = style === 'panel' && (r === 0 || r === R - 1) && (c === 0 || c === C - 1);
      for (let i = 0; i < sx; i++) {
        const x = c * sx + i;
        if (style === 'panel') {
          if (!corner) for (let z = S.relief; z < D; z++) cells.set(key(x, z), panelColor!);
          if (b >= 0) for (let z = 0; z < S.relief; z++) cells.set(key(x, z), b);
        } else if (b >= 0) for (let z = 0; z < D; z++) cells.set(key(x, z), b);
      }
    }
    rowCells.set(r, cells);
  }
  const rows = [...rowCells.keys()].filter(r => rowCells.get(r)!.size);
  if (!rows.length) throw new Error('empty logo');
  const rTop = rows[0], rBot = rows[rows.length - 1];

  // ---------- 2. loose or long-overhanging parts get a clear support column ----------
  let columns = 0;
  for (let r = rBot - 1; r >= rTop; r--) {
    const cells = rowCells.get(r)!;
    if (!cells.size) continue;
    for (let iter = 0; iter < 60; iter++) {
      const below = rowCells.get(r + 1)!;
      const dist = new Map<number, number>(), q: number[] = [];
      for (const k of cells.keys()) if (below.has(k)) { dist.set(k, 0); q.push(k); }
      for (let i = 0; i < q.length; i++) {
        const k = q[i], x = kx(k), z = kz(k);
        for (const n of [key(x + 1, z), key(x - 1, z), key(x, z + 1), key(x, z - 1)]) if (cells.has(n) && !dist.has(n)) { dist.set(n, dist.get(k)! + 1); q.push(n); }
      }
      // a part with nothing under it at all comes first, then the longest overhang
      let far: number | null = null, fd = S.cantilever;
      for (const k of cells.keys()) {
        const d = dist.get(k) ?? Infinity;
        if (d === Infinity) { far = k; break; }
        if (d > fd) { fd = d; far = k; }
      }
      if (far === null) break;
      if (dist.get(far) === undefined) {
        // loose part: put the column under its middle, not its first cell
        const comp: number[] = [far], seen = new Set([far]);
        for (let i = 0; i < comp.length; i++) {
          const x = kx(comp[i]), z = kz(comp[i]);
          for (const n of [key(x + 1, z), key(x - 1, z), key(x, z + 1), key(x, z - 1)]) if (cells.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); }
        }
        const xs = comp.map(kx).sort((a, b) => a - b);
        const mx = xs[Math.floor(xs.length / 2)];
        far = comp.filter(k => kx(k) === mx).sort((a, b) => kz(a) - kz(b))[0];
      }
      const X = Math.floor(kx(far) / sx) * sx, Z = Math.max(0, Math.min(D - sx, Math.floor(kz(far) / sx) * sx));
      const foot: number[] = [];
      for (let i = 0; i < sx; i++) for (let j = 0; j < sx; j++) if (cells.has(key(X + i, Z + j))) foot.push(key(X + i, Z + j));
      if (!foot.length) foot.push(far);
      for (let rr = r + 1; rr <= rBot; rr++) {
        const rc = rowCells.get(rr)!;
        if (foot.every(k => rc.has(k))) break;
        for (const k of foot) if (!rc.has(k)) rc.set(k, TRANS_CLEAR);
      }
      columns++;
    }
  }
  if (columns) notes.push(`${columns} clear support column${columns > 1 ? 's' : ''} hold${columns > 1 ? '' : 's'} up parts of the logo that don’t touch anything below.`);

  // ---------- 3. base: as wide as the sign, deep enough not to tip ----------
  const all = [...rowCells.values()].flatMap(c => [...c.keys()]);
  const bx0 = Math.min(...all.map(kx)) - S.baseMargin.side, bx1 = Math.max(...all.map(kx)) + S.baseMargin.side;
  const rowH = (S.rowLayers.reduce((a, l) => a + l.h, 0) + (S.rowLayersAlt ?? S.rowLayers).reduce((a, l) => a + l.h, 0)) / 2;
  const heightStuds = ((rBot - rTop + 1) * rowH) / 2.5;           // 2.5 plates ≈ 1 stud
  const minDepth = Math.max(D + S.baseMargin.front + S.baseMargin.back, Math.ceil(heightStuds * 0.3));
  let front = S.baseMargin.front, back = S.baseMargin.back;
  while (front + D + back < minDepth) { if (front <= back + 1) front++; else back++; }
  const bz0 = -front, bz1 = D - 1 + back;
  const baseCells = new Set<number>();
  for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) baseCells.add(key(x, z));

  // ---------- 4. which cells can be seen ----------
  const opaque = (r: number, k: number) => {
    if (r > rBot) return baseCells.has(k);
    const c = rowCells.get(r)?.get(k);
    return c !== undefined && !COLOR_BY_ID.get(c)?.trans;
  };
  const layerCells = (r: number): Layer => {
    const out: Layer = new Map(), cells = rowCells.get(r)!;
    for (const [k, c] of cells) {
      const x = kx(k), z = kz(k);
      const vis = !!COLOR_BY_ID.get(c)?.trans
        || [key(x + 1, z), key(x - 1, z), key(x, z + 1), key(x, z - 1)].some(n => !opaque(r, n));
      out.set(k, { c, vis });
    }
    return out;
  };

  // ---------- 5. layers of bricks and plates ----------
  const groupOf = (L: LayerRec): Piece['group'] => (L.row === null ? 'base' : 'body');
  const occupied = (L: LayerRec) => new Set(L.pieces.flatMap(p => { const o2: number[] = []; for (let i = 0; i < p.w; i++) for (let j = 0; j < p.d; j++) o2.push(key(p.x + i, p.z + j)); return o2; }));
  const cache = new Map<number, Layer>();
  const makeLayers = (split: Set<number>, repairNotes: string[]): LayerRec[] => {
    const layers: LayerRec[] = [];
    let y = -S.baseLayers.reduce((a, l) => a + l.h, 0);
    for (const l of S.baseLayers) {
      const cells: Layer = new Map();
      for (const k of baseCells) { const x = kx(k), z = kz(k); cells.set(k, { c: BLACK, vis: x === bx0 || x === bx1 || z === bz0 || z === bz1 }); }
      layers.push({ y, h: l.h, kind: l.kind, cells, row: null, pieces: [] }); y += l.h;
    }
    for (let r = rBot; r >= rTop; r--) {
      if (!rowCells.get(r)!.size) {   // an empty row (cut-out logos with a gap): keep the height with clear-free spacing
        const own = S.rowLayersAlt && (rBot - r) % 2 === 1 ? S.rowLayersAlt : S.rowLayers;
        y += own.reduce((a, q) => a + q.h, 0); continue;
      }
      if (!cache.has(r)) cache.set(r, layerCells(r));
      const cells = cache.get(r)!;
      const own = S.rowLayersAlt && (rBot - r) % 2 === 1 ? S.rowLayersAlt : S.rowLayers;
      const height = own.reduce((a, q) => a + q.h, 0);
      const spec = split.has(r) ? Array.from({ length: height }, () => ({ kind: 'plate' as Kind, h: 1 })) : own;
      for (const l of spec) { layers.push({ y, h: l.h, kind: l.kind, cells, row: r, pieces: [] }); y += l.h; }
    }
    layers.forEach((L, i) => {
      const prev = i ? layers[i - 1] : null;
      const touching = prev && prev.y + prev.h === L.y;
      L.pieces = tileLayer(L.cells, { kind: L.kind, y: L.y, h: L.h, prefX: i % 2 === 0, sizes: SIZES, below: touching ? occupied(prev!) : null, belowPieces: touching ? prev!.pieces : undefined, group: groupOf(L), allow });
    });
    repair(layers, repairNotes, groupOf, allow);
    return layers;
  };
  const split = new Set<number>();
  let repairNotes: string[] = [];
  let layers = makeLayers(split, repairNotes);
  for (let round = 0; round < 10 && S.rowLayers.length === 1; round++) {
    const ps = layers.flatMap(L => L.pieces), { adj } = connections(ps), g = grounded(ps, adj);
    const idx = new Map(ps.map((p, i) => [p, i]));
    const bad = new Set<number>();
    layers.forEach(L => L.pieces.forEach(p => { if (L.row !== null && !g[idx.get(p)!] && !split.has(L.row)) bad.add(L.row); }));
    if (!bad.size) break;
    split.add(Math.max(...bad));   // lowest row first: its failure often causes the ones above
    repairNotes = [];
    layers = makeLayers(split, repairNotes);
  }
  notes.push(...repairNotes);
  if (split.size) notes.push(`${split.size} row${split.size > 1 ? 's' : ''} built from plates instead of bricks so the details interlock.`);

  // ---------- 6. smooth tops: tiles, and the name plate on the base ----------
  const tops: Piece[] = [];
  const cxMid = Math.round((bx0 + bx1 + 1) / 2);
  layers.forEach((L, i) => {
    const next = layers[i + 1];
    const touchingNext = next && next.y === L.y + L.h;
    const nextOcc = touchingNext ? occupied(next) : new Set<number>();
    const exposed: Layer = new Map();
    for (const [k, cell] of L.cells) if (!(touchingNext && (next.cells.has(k) || nextOcc.has(k)))) exposed.set(k, { c: cell.c, vis: true });
    if (!exposed.size) return;
    const top = L.y + L.h;
    if (L.row === null && S.nameplate && i === S.baseLayers.length - 1) {
      const [w, d] = S.nameplate, cx0 = cxMid - Math.floor(w / 2);
      const z0 = -Math.ceil((front + d) / 2);
      let ok = true;
      for (let i2 = 0; i2 < w; i2++) for (let j = 0; j < d; j++) if (!exposed.has(key(cx0 + i2, z0 + j))) ok = false;
      if (ok && (!allow || allow('tile', w, d, BASE_GRAY))) {
        for (let i2 = 0; i2 < w; i2++) for (let j = 0; j < d; j++) exposed.delete(key(cx0 + i2, z0 + j));
        tops.push({ x: cx0, z: z0, y: top, h: 1, w, d, c: BASE_GRAY, kind: 'tile', part: partId('tile', w, d), group: 'base', nameplate: true });
      }
    }
    tops.push(...tileLayer(exposed, { kind: 'tile', y: top, h: 1, prefX: i % 2 === 1, sizes: TILE_SIZES, group: groupOf(L), allow }));
  });

  // ---------- 7. steps, parts list, checks ----------
  const pieces: Piece[] = [...layers.flatMap(L => L.pieces), ...tops];
  const layerYs = [...new Set(pieces.map(p => p.y))].sort((a, b) => a - b);
  const stepOf = pieces.map(p => layerYs.indexOf(p.y));
  const { adj } = connections(pieces);
  const deferred = new Set<number>();
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    pieces.forEach((p, i) => {
      if (stepOf[i] === 0) return;
      const nb = [...adj[i].keys()];
      if (nb.some(j => pieces[j].y < p.y && stepOf[j] <= stepOf[i])) return;
      const up = nb.filter(j => pieces[j].y > p.y).map(j => stepOf[j]);
      if (!up.length) return;
      const s = Math.min(...up);
      if (s > stepOf[i]) { stepOf[i] = s; deferred.add(i); changed = true; }
    });
    if (!changed) break;
  }
  const byStep: number[][] = layerYs.map(() => []);
  pieces.forEach((_, i) => byStep[stepOf[i]].push(i));
  const steps = byStep.filter(s => s.length).map(s => s.sort((a, b) => {
    const da = deferred.has(a) ? 1 : 0, db = deferred.has(b) ? 1 : 0;
    if (da !== db) return da - db;
    const pa = pieces[a], pb = pieces[b];
    return (da ? pb.y - pa.y : pa.y - pb.y) || pa.z - pb.z || pa.x - pb.x;
  }));

  const checks = checkModel(pieces);
  if (checks.floating) notes.push(`${checks.floating} piece${checks.floating > 1 ? 's are' : ' is'} not connected to the base.`);
  const bomMap = new Map<string, BomLine>();
  for (const p of pieces) {
    const k = `${p.part}|${p.c}`, col = COLOR_BY_ID.get(p.c)!;
    const line = bomMap.get(k) ?? { part: p.part, kind: p.kind, name: partName(p.kind, p.w, p.d), color: p.c, colorName: col.name, hex: col.hex, w: Math.min(p.w, p.d), d: Math.max(p.w, p.d), qty: 0 };
    line.qty++; bomMap.set(k, line);
  }
  const bom = [...bomMap.values()].sort((a, b) => a.colorName.localeCompare(b.colorName) || a.kind.localeCompare(b.kind) || a.w - b.w || a.d - b.d);
  const colors: Record<number, string> = {};
  for (const p of pieces) colors[p.c] = COLOR_BY_ID.get(p.c)!.hex;
  const xs = pieces.flatMap(p => [p.x, p.x + p.w]), zs = pieces.flatMap(p => [p.z, p.z + p.d]), ys = pieces.flatMap(p => [p.y, p.y + p.h]);
  const dims = [(Math.max(...xs) - Math.min(...xs)) * 0.8, (Math.max(...zs) - Math.min(...zs)) * 0.8, (Math.max(...ys) - Math.min(...ys)) * 0.32].map(v => Math.round(v)) as [number, number, number];
  return { size, style, panelColor, pieces, steps, bom, colors, checks, notes, dims };
}

/** Fix pieces that aren't connected to the base: re-tile around them, bridge from above, or add a support column. */
function repair(layers: LayerRec[], notes: string[], groupOf: (L: LayerRec) => Piece['group'], allow?: TileOpts['allow']) {
  const flat = () => layers.flatMap(L => L.pieces);
  const floatingCount = () => {
    const ps = flat(); const { adj } = connections(ps); const g = grounded(ps, adj);
    return { ps, g, idx: new Map(ps.map((p, i) => [p, i])), n: g.filter(v => !v).length };
  };
  const cellsOf = (p: Piece) => { const o: number[] = []; for (let i = 0; i < p.w; i++) for (let j = 0; j < p.d; j++) o.push(key(p.x + i, p.z + j)); return o; };
  const near = (p: Piece, q: Piece, m: number) => q.x < p.x + p.w + m && p.x < q.x + q.w + m && q.z < p.z + p.d + m && p.z < q.z + q.d + m;
  const gap = (p: Piece, q: Piece) => Math.max(0, q.x - p.x - p.w, p.x - q.x - q.w) + Math.max(0, q.z - p.z - p.d, p.z - q.z - q.d) + Math.abs(q.y - p.y) * 0.3;
  let pillars = 0;

  const attempt = (P: Piece, st: ReturnType<typeof floatingCount>): boolean => {
    const Li = layers.findIndex(L => L.pieces.includes(P));
    const groundedCells = (li: number) => {
      const out = new Set<number>();
      if (li < 0 || li >= layers.length) return out;
      layers[li].pieces.forEach(p => { if (st.g[st.idx.get(p)!]) cellsOf(p).forEach(k => out.add(k)); });
      return out;
    };
    const retile = (li: number, priority: number[], below: Set<number>) => {
      const L = layers[li], old = L.pieces;
      const region = old.filter(q => !q.support && near(P, q, 4));
      const cells: Layer = new Map();
      region.forEach(q => cellsOf(q).forEach(k => cells.set(k, L.cells.get(k)!)));
      const fresh = tileLayer(cells, { kind: L.kind, y: L.y, h: L.h, prefX: li % 2 === 0, sizes: SIZES, below, priority, group: groupOf(L), allow });
      L.pieces = [...old.filter(q => !region.includes(q)), ...fresh];
      return () => { L.pieces = old; };
    };
    const pc = new Set(cellsOf(P));
    const tries: (() => (() => void) | null)[] = [
      () => (Li > 0 ? retile(Li, [...pc], groundedCells(Li - 1)) : null),
      () => {
        if (Li + 1 >= layers.length) return null;
        const pri = [...layers[Li + 1].cells.keys()].filter(k => pc.has(k));
        if (!pri.length) return null;
        const g = groundedCells(Li); pc.forEach(k => g.delete(k));
        return retile(Li + 1, pri, g);
      },
      () => {
        if (Li < 2) return null;
        const pri = [...layers[Li - 1].cells.keys()].filter(k => pc.has(k));
        if (!pri.length) return null;
        return retile(Li - 1, pri, groundedCells(Li - 2));
      },
    ];
    for (const t of tries) {
      const undo = t();
      if (!undo) continue;
      if (floatingCount().n < st.n) return true;
      undo();
    }
    for (const k of pc) {
      const added: [LayerRec, Piece][] = [];
      let ok = false;
      for (let li = Li - 1; li >= 0; li--) {
        const L = layers[li];
        if (L.pieces.some(q => cellsOf(q).includes(k))) { ok = true; break; }
        const p: Piece = { x: kx(k), z: kz(k), y: L.y, h: L.h, w: 1, d: 1, c: TRANS_CLEAR, kind: L.kind, part: partId(L.kind, 1, 1), group: groupOf(L), support: true };
        L.pieces.push(p); added.push([L, p]);
      }
      if (ok && floatingCount().n < st.n) { pillars++; return true; }
      for (const [L, p] of added) L.pieces.splice(L.pieces.indexOf(p), 1);
    }
    return false;
  };

  for (let iter = 0; iter < 400; iter++) {
    const st = floatingCount();
    if (!st.n) break;
    const solid = st.ps.filter((_, i) => st.g[i]);
    const loose = st.ps.filter((_, i) => !st.g[i])
      .map(P => ({ P, d: Math.min(...solid.filter(q => Math.abs(q.y - P.y) <= 6).map(q => gap(P, q)), 99) }))
      .sort((a, b) => a.d - b.d).slice(0, 12);
    if (!loose.some(({ P }) => attempt(P, st))) break;
  }
  if (pillars) notes.push(`${pillars} clear support stack${pillars > 1 ? 's' : ''} added under loose pieces.`);
}
