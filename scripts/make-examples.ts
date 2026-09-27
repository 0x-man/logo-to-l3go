// Regenerates the made-up example logos in public/examples: npx tsx scripts/make-examples.ts
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { FIXTURES } from '../test/img';
const out = new URL('../public/examples/', import.meta.url).pathname;
const save = (name: string, img: { width: number; height: number; data: ArrayLike<number> }) => {
  const c = createCanvas(img.width, img.height); const x = c.getContext('2d');
  const id = x.createImageData(img.width, img.height); id.data.set(img.data); x.putImageData(id, 0, 0);
  writeFileSync(out + name, c.toBuffer('image/png'));
};
save('nordly.png', FIXTURES.wordmark());
save('quokka.png', FIXTURES.appIcon());
save('rings.png', FIXTURES.rings());
save('go.png', FIXTURES.gradient());
