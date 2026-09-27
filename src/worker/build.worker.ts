// Runs logo reading and model building off the main thread.
import { buildModel, type BuildOptions, type Model, type SizeId } from '../core/build';
import { LogoError, pixelize, type LogoGrid, type PixelizeOptions, type RGBAImage } from '../core/logo';

export type BuildRequest = { id: number; size: SizeId; image?: RGBAImage; read?: PixelizeOptions; grid?: LogoGrid; opts: BuildOptions };
export type BuildReply =
  | { id: number; ok: true; grid: LogoGrid; model: Model; ms: number }
  | { id: number; ok: false; code: string; message: string };

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, size, image, read, opts } = e.data;
  const t = performance.now();
  try {
    const grid = e.data.grid ?? pixelize(image!, read);
    const model = buildModel(grid, size, opts);
    (self as unknown as Worker).postMessage({ id, ok: true, grid, model, ms: performance.now() - t } satisfies BuildReply);
  } catch (err) {
    const code = err instanceof LogoError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ id, ok: false, code, message: code === 'error' ? `Something went wrong while building: ${message}` : message } satisfies BuildReply);
  }
};
