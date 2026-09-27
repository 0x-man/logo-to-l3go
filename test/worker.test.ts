import { describe, expect, it, vi, afterEach } from 'vitest';
// @ts-expect-error plain JS module
import worker, { findCandidates, safeUrl, sniffImage, safeFetch, UserError } from '../logo-api/worker.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ORIGIN = 'https://me.github.io';
const env = { ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173` };
const ctx = { waitUntil: () => {} };
const call = (path: string, origin: string | null = ORIGIN, method = 'GET') =>
  worker.fetch(new Request(`https://api.example.workers.dev${path}`, { method, headers: origin ? { Origin: origin } : {} }), env, ctx) as Promise<Response>;

describe('safeUrl: only public web addresses', () => {
  it.each(['example.com', 'https://www.example.com/about', 'http://shop.example.co.uk', 'EXAMPLE.com:443', 'xn--bcher-kva.com'])('allows %s', s => {
    expect(() => safeUrl(s.replace('example.com', 'acme.com'))).not.toThrow();
  });
  it.each([
    'localhost', 'http://localhost:8080', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://[::1]/', 'http://[fd00::1]', 'http://10.0.0.1', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.1',
    'http://printer.local', 'http://metadata.google.internal', 'http://router.lan', 'http://127.0.0.1.nip.io', 'http://10-0-0-1.sslip.io',
    'ftp://acme.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@acme.com', 'https://acme.com:8443', 'intranet', '',
  ])('refuses %s', s => {
    expect(() => safeUrl(s)).toThrow(UserError);
  });
});

describe('sniffImage: by bytes, not by label', () => {
  it('recognises real images and SVG', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<!-- hi -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
  });
  it('refuses pages and scripts pretending to be images', () => {
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('alert(1)'))).toBeNull();
  });
});

describe('findCandidates', () => {
  const page = new URL('https://www.acme.com/en/');
  const html = `<!doctype html><html><head>
    <link rel="icon" href="/favicon-32.png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta property="og:image" content="https://cdn.acme.com/share.jpg">
    <script type="application/ld+json">{"@type":"Organization","logo":"https:\\/\\/cdn.acme.com\\/logo-ld.png"}</script>
    </head><body><header><a class="site-logo" href="/"><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></a>
    <img src="img/acme-logo.svg" alt="Acme"></header>
    <!-- <img src="commented-logo.png"> -->
    <img src="javascript:alert(1)" alt="logo"><img src="photo.jpg" alt="team">
    </body></html>`;
  const c = findCandidates(html, page);
  it('ranks the header logo first and resolves relative links', () => {
    // a logo file in the header beats an inline drawing (which may rely on the page's CSS for colour)
    expect(c[0].url).toBe('https://www.acme.com/en/img/acme-logo.svg');
    const inline = c.find((x: { kind: string }) => x.kind === 'svg');
    expect(inline.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(c.map((x: { url?: string }) => x.url)).toContain('https://www.acme.com/en/img/acme-logo.svg');
    expect(c.map((x: { url?: string }) => x.url)).toContain('https://cdn.acme.com/logo-ld.png');
  });
  it('skips comments, javascript: links and unrelated photos', () => {
    const urls = c.map((x: { url?: string }) => x.url ?? '').join(' ');
    expect(urls).not.toContain('commented');
    expect(urls).not.toContain('javascript');
    expect(urls).not.toContain('photo.jpg');
    expect(urls).toContain('https://www.acme.com/favicon.ico');
  });
});

describe('safeFetch: redirects are checked hop by hop', () => {
  it('refuses a redirect to a private address', async () => {
    const fake = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    await expect(safeFetch('acme.com', '*/*', 1000, fake)).rejects.toThrow(/IP address/);
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it('stops reading past the size cap', async () => {
    const fake = vi.fn(async () => new Response(new Uint8Array(5000)));
    await expect(safeFetch('acme.com', '*/*', 1000, fake)).rejects.toThrow(/too big/);
  });
  it('gives up after too many redirects', async () => {
    const fake = vi.fn(async () => new Response(null, { status: 301, headers: { Location: 'https://acme.com/again' } }));
    await expect(safeFetch('acme.com', '*/*', 1000, fake)).rejects.toThrow(/redirects/);
  });
});

describe('the Worker end to end (fake network)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('answers only its own site', async () => {
    expect((await call('/find?site=acme.com', 'https://evil.example')).status).toBe(403);
    expect((await call('/find?site=acme.com', null)).status).toBe(403);
    expect((await call('/find?site=acme.com', ORIGIN, 'POST')).status).toBe(405);
  });
  it('finds candidates and serves images with safe headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => u.endsWith('.png')
      ? new Response(PNG, { headers: { 'Content-Type': 'text/html' } })     // lies about its type: the bytes decide
      : new Response('<img src="/logo.png" alt="logo">', { headers: { 'Content-Type': 'text/html' } })));
    const f = await call('/find?site=acme.com');
    expect(f.status).toBe(200);
    expect(f.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const body = await f.json();
    expect(body.candidates[0].url).toBe('https://acme.com/logo.png');
    const img = await call(`/image?url=${encodeURIComponent('https://acme.com/logo.png')}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    expect(img.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('refuses to proxy something that is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>steal()</script>', { headers: { 'Content-Type': 'image/png' } })));
    const r = await call(`/image?url=${encodeURIComponent('https://acme.com/x.png')}`);
    expect(r.status).toBe(415);
  });
  it('applies the rate limit when configured', async () => {
    const limited = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const r = await worker.fetch(new Request('https://api.example.workers.dev/find?site=acme.com', { headers: { Origin: ORIGIN } }), limited, ctx);
    expect(r.status).toBe(429);
  });
});
