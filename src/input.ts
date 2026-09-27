// Getting a logo into pixels: files (PNG, JPEG, WebP, GIF, AVIF, ICO, SVG)
// and, through the logo finder Worker, websites.
import type { RGBAImage } from './core/logo';

/** Where the logo finder Worker lives, set at build time (see DEPLOY.md). Empty = website search is off. */
export const LOGO_API = String(import.meta.env.VITE_LOGO_API ?? '').trim().replace(/\/+$/, '');

const MAX_FILE = 15 * 1024 * 1024;       // 15 MB
const MAX_PIXELS = 40_000_000;           // refuse absurd image sizes before they eat the tab's memory
const WORK = 1024;                       // longest side we keep: plenty for a 64-stud sign

const isSvg = (blob: Blob, name = '') => blob.type === 'image/svg+xml' || /\.svg$/i.test(name);

/** Draws an image source onto a canvas no bigger than WORK, keeping transparency. */
function toRGBA(src: CanvasImageSource, w: number, h: number): RGBAImage {
  if (!w || !h) throw new Error('empty image');
  if (w * h > MAX_PIXELS) throw new Error('This image is too large. Use one under 40 megapixels.');
  const k = Math.min(1, WORK / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H);
  return { width: W, height: H, data: d.data };
}

/** Loads a blob through an <img> element (needed for SVG and ICO in some browsers). */
function viaImg(blob: Blob): Promise<RGBAImage> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  return img.decode().then(() => toRGBA(img, img.naturalWidth, img.naturalHeight)).finally(() => URL.revokeObjectURL(url));
}

/**
 * An SVG, made safe and sized. It's only ever drawn through an <img>, where
 * browsers never run scripts or fetch anything; we still strip scripts,
 * event handlers and outside links as a second line of defence, and give it
 * a real pixel size (many logos only have a viewBox).
 */
export async function svgToImage(text: string): Promise<RGBAImage> {
  if (text.length > 5_000_000) throw new Error('This SVG is too large.');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('This SVG file couldn’t be read.');
  doc.querySelectorAll('script, foreignObject, iframe, object, embed, audio, video').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href') && !v.startsWith('#') && !v.startsWith('data:image/')) el.removeAttribute(a.name);
    }
  });
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  let w = parseFloat(svg.getAttribute('width') ?? ''), h = parseFloat(svg.getAttribute('height') ?? '');
  if (/%/.test(svg.getAttribute('width') ?? '') || !(w > 0)) w = vb.length === 4 && vb[2] > 0 ? vb[2] : 0;
  if (/%/.test(svg.getAttribute('height') ?? '') || !(h > 0)) h = vb.length === 4 && vb[3] > 0 ? vb[3] : 0;
  if (!(w > 0 && h > 0)) { w = 512; h = 512; }
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const k = WORK / Math.max(w, h);
  svg.setAttribute('width', String(Math.round(w * k)));
  svg.setAttribute('height', String(Math.round(h * k)));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const out = new XMLSerializer().serializeToString(svg);
  return viaImg(new Blob([out], { type: 'image/svg+xml' }));
}

/** Any image file or blob -> pixels. */
export async function blobToImage(blob: Blob, name = ''): Promise<RGBAImage> {
  if (blob.size > MAX_FILE) throw new Error('This file is over 15 MB. Use a smaller logo file.');
  if (isSvg(blob, name)) return svgToImage(await blob.text());
  try {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
    try { return toRGBA(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
  } catch (e) {
    if (e instanceof Error && /too large/.test(e.message)) throw e;
    // some formats (ICO, some SVG-as-image) only decode through <img>; if the bytes are really SVG, go that way
    const head = await blob.slice(0, 512).text();
    if (/<svg[\s>]/i.test(head)) return svgToImage(await blob.text());
    return viaImg(blob);
  }
}

// ---------- the logo finder ----------

export interface Candidate { url?: string; svg?: string; kind: string; label: string; score: number }

const okUrl = (u: unknown): u is string => typeof u === 'string' && u.length < 300_000 && /^(https?:\/\/|data:image\/(svg\+xml|png|jpeg|gif|webp)[;,])/i.test(u);

async function api(path: string): Promise<Response> {
  if (!LOGO_API) throw new Error('Website search isn’t set up on this copy of the site. Drop the logo file instead.');
  let r: Response;
  try {
    r = await fetch(LOGO_API + path, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'default', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('We couldn’t reach the logo finder. Check your connection, or drop the logo file instead.');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 200) : `The logo finder answered with an error (${r.status}).`);
  }
  return r;
}

/** Candidate logos on a website's home page, best first. Everything in the answer is checked, not trusted. */
export async function findLogos(site: string): Promise<{ site: string; candidates: Candidate[] }> {
  const r = await api(`/find?site=${encodeURIComponent(site.trim())}`);
  const body = await r.json() as { site?: unknown; candidates?: unknown };
  const list = Array.isArray(body.candidates) ? body.candidates : [];
  const candidates: Candidate[] = [];
  for (const c of list.slice(0, 8) as Record<string, unknown>[]) {
    const label = typeof c.label === 'string' ? c.label.slice(0, 60) : 'Image';
    const score = typeof c.score === 'number' ? c.score : 0;
    if (typeof c.svg === 'string' && c.svg.length < 200_000 && /^<svg[\s>]/i.test(c.svg.trim())) candidates.push({ svg: c.svg, kind: 'svg', label, score });
    else if (okUrl(c.url)) candidates.push({ url: c.url, kind: String(c.kind ?? 'image').slice(0, 10), label, score });
  }
  return { site: typeof body.site === 'string' ? body.site.slice(0, 100) : site, candidates };
}

function dataUrlToBlob(u: string): Blob {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(u);
  if (!m) throw new Error('bad data URL');
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;
  return new Blob([bytes], { type: m[1] });
}

/** The pixels of one candidate. */
export async function loadCandidate(c: Candidate): Promise<RGBAImage> {
  if (c.svg) return svgToImage(c.svg);
  if (c.url!.startsWith('data:')) return blobToImage(dataUrlToBlob(c.url!));
  const r = await api(`/image?url=${encodeURIComponent(c.url!)}`);
  const blob = await r.blob();
  return blobToImage(blob, new URL(c.url!).pathname);
}

/** A small preview of an image for the candidate strip. */
export function thumb(img: RGBAImage, size = 88): HTMLCanvasElement {
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d')!, k = Math.min(size / img.width, size / img.height) * 0.9;
  x.drawImage(src, (size - img.width * k) / 2, (size - img.height * k) / 2, img.width * k, img.height * k);
  return c;
}
