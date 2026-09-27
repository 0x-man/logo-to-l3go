// Any logo image (PNG with transparency, JPEG on a flat background, a
// rasterised SVG, a favicon) -> a small grid of real brick colours.
import { rgbToLab, type Lab, type RGB } from './color';
import { mapColors } from './palette';

export interface RGBAImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export interface LogoGrid {
  w: number;
  h: number;
  /** h rows × w cols; -1 = background, otherwise index into `colors` */
  cells: number[][];
  colors: { rgb: RGB; count: number; brick: number }[];
  /** flat background colour of the source image, null when it was transparent or there was none */
  background: RGB | null;
  /** how the background was found */
  bgMode: 'transparent' | 'flat' | 'none';
}

export interface PixelizeOptions {
  /** pixels across (each pixel becomes one stud, or 2×2 studs in XL); default: picked from the logo's shape */
  width?: number;
  /** most brick colours to use for the logo (default 6) */
  maxColors?: number;
  /** treat the whole picture as the logo, even if it has a flat background */
  keepBackground?: boolean;
}

export class LogoError extends Error {
  constructor(public code: 'empty' | 'tiny', message: string) { super(message); }
}

export const MIN_W = 12, MAX_W = 64, MAX_H = 48;
const WORK = 640;             // longest side of the working copy
const COVER = 0.38;           // share of a cell the logo must cover to become a brick (a little generous: thin strokes survive)

/** Auto width: about 700 pixels in total, so the model stays a sensible size. */
export function autoWidth(aspect: number): number {
  let w = Math.round(Math.sqrt(700 * aspect));
  w = Math.max(MIN_W, Math.min(MAX_W, w));
  if (w / aspect > MAX_H) w = Math.max(MIN_W, Math.round(MAX_H * aspect));
  return w;
}

/** Box-filter downscale with premultiplied alpha, so transparent pixels don't darken edges. */
function downscale(img: RGBAImage, max: number): RGBAImage {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  if (k === 1) return img;
  const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
  const acc = new Float64Array(W * H * 4), n = new Float64Array(W * H);
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    const Y = Math.min(H - 1, Math.floor((y * H) / img.height));
    for (let x = 0; x < img.width; x++) {
      const X = Math.min(W - 1, Math.floor((x * W) / img.width)), o = (y * img.width + x) * 4, t = Y * W + X, a = d[o + 3] / 255;
      acc[t * 4] += d[o] * a; acc[t * 4 + 1] += d[o + 1] * a; acc[t * 4 + 2] += d[o + 2] * a; acc[t * 4 + 3] += d[o + 3];
      n[t]++;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let t = 0; t < W * H; t++) {
    const a = n[t] ? acc[t * 4 + 3] / n[t] : 0;
    const s = a > 0 ? 255 / a / n[t] : 0;
    out[t * 4] = acc[t * 4] * s; out[t * 4 + 1] = acc[t * 4 + 1] * s; out[t * 4 + 2] = acc[t * 4 + 2] * s; out[t * 4 + 3] = a;
  }
  return { width: W, height: H, data: out };
}

const d2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Find the background: transparent, one flat colour around the border, or none. */
function findBackground(img: RGBAImage, labs: Lab[]): { mode: LogoGrid['bgMode']; lab: Lab | null; rgb: RGB | null } {
  const { width: W, height: H, data } = img;
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  let clear = 0, clearAll = 0;
  for (const p of border) if (data[p * 4 + 3] < 128) clear++;
  for (let p = 0; p < W * H; p++) if (data[p * 4 + 3] < 128) clearAll++;
  if (clear / border.length > 0.3 || clearAll / (W * H) > 0.08) return { mode: 'transparent', lab: null, rgb: null };
  // most common border colour (coarse bins), then everything close to it
  const bins = new Map<number, number[]>();
  for (const p of border) {
    const o = p * 4, b = ((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4);
    (bins.get(b) ?? bins.set(b, []).get(b)!).push(p);
  }
  const top = [...bins.values()].sort((a, b) => b.length - a.length)[0];
  const rgb: RGB = [0, 0, 0];
  for (const p of top) for (let i = 0; i < 3; i++) rgb[i] += data[p * 4 + i] / top.length;
  const lab = rgbToLab(rgb);
  const near = border.filter(p => d2(labs[p], lab) < 12 * 12).length;
  if (near / border.length < 0.6) return { mode: 'none', lab: null, rgb: null };
  return { mode: 'flat', lab, rgb: rgb.map(Math.round) as RGB };
}

/** k-means in Lab (k-means++ start), on a sample of solid logo pixels. */
function cluster(samples: Lab[], k: number): Lab[] {
  if (!samples.length) return [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cs: Lab[] = [samples[Math.floor(rnd() * samples.length)]];
  const dist = new Float64Array(samples.length);
  while (cs.length < k) {
    let sum = 0;
    samples.forEach((s, i) => { dist[i] = Math.min(...cs.map(c => d2(s, c))); sum += dist[i]; });
    if (sum === 0) break;
    let r = rnd() * sum, i = 0;
    while (r > dist[i] && i < samples.length - 1) r -= dist[i++];
    cs.push(samples[i]);
  }
  for (let it = 0; it < 14; it++) {
    const acc = cs.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let b = 0, bd = Infinity;
      cs.forEach((c, j) => { const d = d2(s, c); if (d < bd) { bd = d; b = j; } });
      acc[b][0] += s[0]; acc[b][1] += s[1]; acc[b][2] += s[2]; acc[b][3]++;
    }
    acc.forEach((a, j) => { if (a[3]) cs[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return cs;
}

export function pixelize(src: RGBAImage, o: PixelizeOptions = {}): LogoGrid {
  const img = downscale(src, WORK);
  const { width: IW, height: IH, data } = img;
  if (IW < 4 || IH < 4) throw new LogoError('tiny', 'This image is too small to read. Use a logo at least 16 pixels across.');
  const labs: Lab[] = new Array(IW * IH);
  const rgbs: RGB[] = new Array(IW * IH);
  for (let p = 0; p < IW * IH; p++) { rgbs[p] = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]; labs[p] = rgbToLab(rgbs[p]); }

  // ---------- 1. how much of each pixel is logo (0..1) ----------
  let bg: ReturnType<typeof findBackground> = o.keepBackground ? { mode: 'none', lab: null, rgb: null } : findBackground(img, labs);
  const weight = new Float32Array(IW * IH);
  const weigh = () => {
    let solid = 0;
    for (let p = 0; p < IW * IH; p++) {
      const a = data[p * 4 + 3] / 255;
      if (bg.mode === 'flat') {
        // anti-aliased edges sit between the background and the logo colour
        const d = Math.sqrt(d2(labs[p], bg.lab!));
        weight[p] = a * Math.min(1, Math.max(0, (d - 5) / 20));
      } else weight[p] = a;
      if (weight[p] >= 0.5) solid++;
    }
    return solid;
  };
  // a picture that is all one flat colour is the logo itself (a plain badge), not background
  if (weigh() < IW * IH * 0.002 && bg.mode === 'flat' && bg.lab![0] < 95) { bg = { mode: 'none', lab: null, rgb: null }; weigh(); }

  // ---------- 2. crop to the logo ----------
  let x0 = IW, y0 = IH, x1 = -1, y1 = -1;
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) if (weight[y * IW + x] >= 0.5) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new LogoError('empty', 'We couldn’t find a logo in this image: it looks empty or all one colour.');
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, aspect = cw / ch;

  // ---------- 3. grid size: square cells ----------
  let W = Math.round(o.width ?? autoWidth(aspect));
  W = Math.max(MIN_W, Math.min(MAX_W, W));
  let H = Math.max(3, Math.round(W / aspect));
  if (H > MAX_H) { H = MAX_H; W = Math.max(3, Math.round(H * aspect)); }
  const sx = cw / W, sy = ch / H;

  // ---------- 4. logo colours ----------
  const solid: Lab[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((cw * ch) / 40000)));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) { const p = y * IW + x; if (weight[p] >= 0.85) solid.push(labs[p]); }
  if (!solid.length) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const p = y * IW + x; if (weight[p] >= 0.5) solid.push(labs[p]); }
  const maxColors = Math.max(1, Math.min(10, o.maxColors ?? 6));
  let centres = cluster(solid, Math.min(solid.length, maxColors + 3));
  // count, then merge near-duplicates and drop specks (anti-alias blends, noise)
  const counts = () => {
    const n = centres.map(() => 0);
    for (const s of solid) { let b = 0, bd = Infinity; centres.forEach((c, j) => { const d = d2(s, c); if (d < bd) { bd = d; b = j; } }); n[b]++; }
    return n;
  };
  for (let it = 0; it < 20 && centres.length > 1; it++) {
    const n = counts();
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) { const d = d2(centres[i], centres[j]); if (d < bd) { bd = d; bi = i; bj = j; } }
    const smallest = n.indexOf(Math.min(...n));
    const tooMany = centres.length > maxColors, speck = n[smallest] < solid.length * 0.012;
    if (bd < 12 * 12 || (!speck && tooMany)) {
      const [a, b] = [n[bi], n[bj]];
      centres[bi] = [0, 1, 2].map(q => (centres[bi][q] * a + centres[bj][q] * b) / Math.max(1, a + b)) as Lab;
      centres.splice(bj, 1);
    } else if (speck || tooMany) centres.splice(smallest, 1);
    else break;
  }
  if (!centres.length) centres = [solid[0]];

  // ---------- 5. one colour per cell ----------
  const nearest = (l: Lab) => { let b = 0, bd = Infinity; centres.forEach((c, j) => { const d = d2(l, c); if (d < bd) { bd = d; b = j; } }); return b; };
  const raw: number[][] = [];
  for (let r = 0; r < H; r++) {
    const row: number[] = [];
    for (let c = 0; c < W; c++) {
      const xa = x0 + c * sx, xb = x0 + (c + 1) * sx, ya = y0 + r * sy, yb = y0 + (r + 1) * sy;
      let cov = 0, n = 0;
      const votes = new Float64Array(centres.length);
      for (let y = Math.floor(ya); y < Math.ceil(yb); y++) for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
        // fractional overlap of source pixel with the cell
        const f = (Math.min(x + 1, xb) - Math.max(x, xa)) * (Math.min(y + 1, yb) - Math.max(y, ya));
        if (f <= 0) continue;
        const p = y * IW + x, w = weight[p];
        cov += w * f; n += f;
        if (w >= 0.5) votes[nearest(labs[p])] += f * w * w;
      }
      const v = Math.max(...votes);
      row.push(n && cov / n >= COVER && v > 0 ? votes.indexOf(v) : -1);
    }
    raw.push(row);
  }

  // ---------- 6. brick colours: two different logo colours that touch stay different ----------
  const used = centres.map(() => 0);
  raw.forEach(row => row.forEach(v => { if (v >= 0) used[v]++; }));
  const touching = new Set<string>();
  const tk = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const v = raw[r][c]; if (v < 0) continue;
    if (c + 1 < W && raw[r][c + 1] >= 0 && raw[r][c + 1] !== v) touching.add(tk(v, raw[r][c + 1]));
    if (r + 1 < H && raw[r + 1][c] >= 0 && raw[r + 1][c] !== v) touching.add(tk(v, raw[r + 1][c]));
  }
  const labToRgb = (l: Lab): RGB => {
    // inverse of rgbToLab (D65), good enough for display and matching
    const fy = (l[0] + 16) / 116, fx = fy + l[1] / 500, fz = fy - l[2] / 200;
    const fi = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
    const X = fi(fx) * 0.95047, Y = fi(fy), Z = fi(fz) * 1.08883;
    const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    const g = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
    return [g(R), g(G), g(B)];
  };
  const pal = centres.map((c, i) => ({ rgb: labToRgb(c), count: used[i] }));
  const bricks = mapColors(pal, touching, { noTrans: true });
  // colours that ended up on the same brick colour become one
  const byBrick = new Map<number, number>();
  const colors: LogoGrid['colors'] = [];
  const remap = pal.map((p, i) => {
    if (!p.count) return -1;
    let j = byBrick.get(bricks[i]);
    if (j === undefined) { j = colors.length; byBrick.set(bricks[i], j); colors.push({ rgb: p.rgb, count: 0, brick: bricks[i] }); }
    colors[j].count += p.count;
    return j;
  });
  const cells = raw.map(row => row.map(v => (v < 0 ? -1 : remap[v])));
  if (!colors.length) throw new LogoError('empty', 'The logo came out empty at this size. Try a larger width.');
  return { w: W, h: H, cells, colors, background: bg.rgb, bgMode: bg.mode };
}
