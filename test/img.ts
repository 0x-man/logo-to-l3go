// Node-only helpers for tests: draws made-up logos (no real brands) with a real canvas.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { RGBAImage } from '../src/core/logo';

// DejaVu Sans Bold ships with the tests (free licence, see test/fonts/README.md) so results match on every machine
if (!GlobalFonts.registerFromPath(new URL('./fonts/DejaVuSans-Bold.ttf', import.meta.url).pathname, 'TestBold')) throw new Error('test font missing');

type Draw = (x: CanvasRenderingContext2D, w: number, h: number) => void;

export function draw(w: number, h: number, bg: string | null, fn: Draw): RGBAImage {
  const c = createCanvas(w, h), x = c.getContext('2d') as unknown as CanvasRenderingContext2D;
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); }
  fn(x, w, h);
  const d = x.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8ClampedArray(d.data) };
}

/** A wordmark with a round mark: navy text, coral dot, on white. */
export const wordmark = () => draw(900, 240, '#FFFFFF', (x) => {
  x.fillStyle = '#F26B4F'; x.beginPath(); x.arc(120, 120, 80, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(120, 120, 34, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#16324F'; x.font = '150px TestBold'; x.textBaseline = 'middle'; x.fillText('Nordly', 240, 130);
});

/** An app icon on a transparent background: orange rounded square, white letter. */
export const appIcon = () => draw(512, 512, null, (x) => {
  x.fillStyle = '#FF8A1F'; x.beginPath(); x.roundRect(40, 40, 432, 432, 96); x.fill();
  x.fillStyle = '#FFFFFF'; x.font = '330px TestBold'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('q', 256, 230);
});

/** A light logo with a loose part, on transparent: white "i" with its dot and a bar. */
export const lightLoose = () => draw(400, 400, null, (x) => {
  x.fillStyle = '#F5F5F5';
  x.fillRect(60, 160, 60, 200); x.beginPath(); x.arc(90, 90, 36, 0, Math.PI * 2); x.fill();
  x.fillRect(160, 60, 180, 50); x.fillRect(225, 60, 50, 300);
});

/** Concentric rings on white: the white ring is background, the centre floats in a cut-out. */
export const rings = () => draw(300, 300, '#FFFFFF', (x) => {
  x.fillStyle = '#CC0000'; x.beginPath(); x.arc(150, 150, 140, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(150, 150, 95, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#CC0000'; x.beginPath(); x.arc(150, 150, 50, 0, Math.PI * 2); x.fill();
});

/** A photo-like gradient badge with no flat background. */
export const gradient = () => draw(300, 200, null, (x) => {
  const g = x.createLinearGradient(0, 0, 300, 200); g.addColorStop(0, '#2A6FDB'); g.addColorStop(1, '#8E3CCB');
  x.fillStyle = g; x.fillRect(0, 0, 300, 200);
  x.fillStyle = '#FFFFFF'; x.font = '90px TestBold'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('GO', 150, 105);
});

export const FIXTURES = { wordmark, appIcon, lightLoose, rings, gradient };
