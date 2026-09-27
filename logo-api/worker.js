// Logo to Bricks: logo finder (Cloudflare Worker, one file, no dependencies).
//
// Browsers can't read other websites directly (CORS), so this small server
// does it for the site:
//   GET /find?site=example.com   -> JSON list of logo candidates found on that page
//   GET /image?url=https://…     -> the image itself (PNG, JPEG, GIF, WebP, AVIF, ICO or SVG, 3 MB max)
//
// Security, in short:
//   - only answers pages listed in ALLOWED_ORIGINS (CORS), GET only
//   - optional per-IP rate limit (RATE_LIMITER binding, see wrangler.toml)
//   - refuses anything that isn't a public http(s) web address: no IP addresses,
//     no localhost / .local / .internal names, no odd ports, no user:password@
//   - follows at most 4 redirects, checking each hop the same way
//   - 8-second timeout, size caps (pages 1.5 MB, images 3 MB), reads stop at the cap
//   - /image only returns real images (checked by their first bytes, not by what
//     the other server claims), with headers that stop an SVG from ever running
//     as a page on this domain
//   - sends no cookies, keeps no logs of what people look up
//
// Settings (Cloudflare dashboard → your Worker → Settings → Variables):
//   ALLOWED_ORIGINS  comma-separated, e.g. "https://yourname.github.io,http://localhost:5173"

const PAGE_MAX = 1_500_000;
const IMAGE_MAX = 3_000_000;
const SVG_INLINE_MAX = 150_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (compatible; LogoToBricks/1.0; logo preview for a brick-building tool)';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;

    if (request.method === 'OPTIONS') {
      if (!cors) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return json({ error: 'Only GET is allowed.' }, 405, cors);
    // Browsers always send Origin on a cross-site fetch. No match = not our site.
    if (!cors) return json({ error: 'This logo finder only answers its own website.' }, 403, null);

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many requests. Wait a minute and try again.' }, 429, cors);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/find') return await cached(request, ctx, () => find(url.searchParams.get('site') || ''), cors);
      if (url.pathname === '/image') return await cached(request, ctx, () => image(url.searchParams.get('url') || ''), cors);
      return json({ error: 'Not found.' }, 404, cors);
    } catch (e) {
      const msg = e instanceof UserError ? e.message : 'Something went wrong while reading that website.';
      return json({ error: msg }, e instanceof UserError ? e.status : 502, cors);
    }
  },
};

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...(cors || {}) },
  });
}

/** Caches successful answers for a day at the edge (keyed on the path and query only). */
async function cached(request, ctx, make, cors) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const u = new URL(request.url);
  const key = new Request(`${u.origin}${u.pathname}?${u.searchParams.toString()}`, { method: 'GET' });
  let res = cache ? await cache.match(key) : null;
  if (!res) {
    res = await make();
    if (cache && res.ok) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('Cache-Control', 'public, max-age=86400');
      ctx.waitUntil(cache.put(key, copy));
    }
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors || {})) out.headers.set(k, v);
  return out;
}

// ---------- which addresses we are willing to fetch ----------

const BLOCKED_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'home.arpa', 'localdomain', 'onion', 'test', 'invalid', 'example'];

/** A public http(s) URL we may fetch, or a UserError. */
export function safeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new UserError('Type a website address, like example.com.');
  if (s.length > 2048) throw new UserError('That address is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(s); } catch { throw new UserError('That doesn’t look like a website address.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UserError('Only http and https addresses work.');
  if (u.username || u.password) throw new UserError('Addresses with a user name or password aren’t allowed.');
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) throw new UserError('Only standard web ports work.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  // IP addresses (IPv6 in brackets; IPv4 in any form the URL parser normalises to dotted digits)
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) throw new UserError('Use the website’s name, not an IP address.');
  if (!host.includes('.')) throw new UserError('That doesn’t look like a public website.');
  // names that spell out an IP address (127.0.0.1.nip.io, 10-0-0-1.sslip.io …)
  if (/(^|[.-])(\d{1,3}[.-]){3}\d{1,3}([.-]|$)/.test(host)) throw new UserError('Use the website’s name, not an IP address.');
  const tld = host.split('.').pop();
  if (BLOCKED_SUFFIXES.some(b => host === b || host.endsWith('.' + b)) || /^\d+$/.test(tld)) throw new UserError('That doesn’t look like a public website.');
  u.hash = '';
  return u;
}

/** fetch() with manual redirects (each hop re-checked), a timeout and a size cap. */
export async function safeFetch(start, accept, max, fetchImpl = fetch) {
  let url = safeUrl(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url.toString(), {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) throw new UserError('That website redirected nowhere.', 502);
      url = safeUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new UserError(`That website answered with an error (${res.status}).`, 502);
    const len = Number(res.headers.get('Content-Length') || 0);
    if (len > max) throw new UserError('That file is too big.', 413);
    const bytes = await readCapped(res, max);
    return { url, bytes, type: (res.headers.get('Content-Type') || '').toLowerCase() };
  }
  throw new UserError('Too many redirects.', 502);
}

async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new UserError('That file is too big.', 413); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- /image ----------

/** What kind of image the bytes really are, or null. */
export function sniffImage(b) {
  const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && (at(8, 0x61, 0x76, 0x69, 0x66) || at(8, 0x61, 0x76, 0x69, 0x73))) return 'image/avif';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  const head = new TextDecoder().decode(b.slice(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) return 'image/svg+xml';
  return null;
}

async function image(input) {
  const { bytes } = await safeFetch(input, 'image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.8', IMAGE_MAX);
  const type = sniffImage(bytes);
  if (!type) throw new UserError('That address isn’t an image we can read.', 415);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      // if anyone opens this URL directly, an SVG still can't run scripts or load anything
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': 'attachment; filename="logo"',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

// ---------- /find ----------

async function find(input) {
  const { url, bytes, type } = await safeFetch(input, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', PAGE_MAX);
  if (type && !/html|xml/.test(type)) {
    // someone pasted a direct image link: offer it as the only candidate
    if (sniffImage(bytes)) return json({ site: url.hostname, candidates: [{ url: url.toString(), kind: 'image', label: 'The image you linked', score: 100 }] }, 200, null);
    throw new UserError('That address isn’t a web page or an image.', 415);
  }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const candidates = findCandidates(html, url);
  if (!candidates.length) throw new UserError('We couldn’t find a logo on that page. Download it yourself and drop the file instead.', 404);
  return json({ site: url.hostname, candidates }, 200, null);
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') { const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[l];
  });
}

/** Logo candidates on a page, best first (pure function: no network). */
export function findCandidates(html, pageUrl) {
  const page = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const baseHref = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  let base = page;
  try { if (baseHref) base = new URL(baseHref, page); } catch { /* keep page */ }
  const brand = page.hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const headerEnd = (() => { const i = html.search(/<\/header>/i); return i < 0 ? Math.min(html.length, 20000) : i; })();
  const found = new Map();
  const add = (raw, kind, label, score) => {
    if (!raw) return;
    let u;
    try { u = new URL(raw.trim(), base); } catch { return; }
    if (u.protocol === 'data:') {
      if (!/^data:image\/(svg\+xml|png|jpeg|gif|webp)[;,]/i.test(raw.trim()) || raw.length > 300_000) return;
    } else if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    const key = u.protocol === 'data:' ? raw.slice(0, 200) : u.toString();
    const prev = found.get(key);
    if (!prev || prev.score < score) found.set(key, { url: u.protocol === 'data:' ? raw.trim() : u.toString(), kind, label, score });
  };
  const addSvg = (svg, label, score) => {
    if (svg.length > SVG_INLINE_MAX) return;
    if (!/xmlns\s*=/.test(svg.slice(0, 400))) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    let h = 0;
    for (let i = 0; i < svg.length; i++) h = (Math.imul(h, 31) + svg.charCodeAt(i)) | 0;
    const key = `svg:${svg.length}:${h}`;
    if (!found.has(key)) found.set(key, { svg, kind: 'svg', label, score });
  };

  // <link rel="icon" …>, apple-touch-icon, mask-icon
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrs(m[1]), rel = (a.rel || '').toLowerCase(), href = a.href;
    if (!href) continue;
    const size = Math.max(0, ...((a.sizes || '').match(/\d+/g) || []).map(Number));
    const svg = /\.svg(\?|$)/i.test(href) || /svg/.test(a.type || '');
    if (/apple-touch-icon/.test(rel)) add(href, 'icon', 'App icon', 58);
    else if (/mask-icon/.test(rel)) add(href, 'icon', 'Single-colour icon', 34);
    else if (/\bicon\b/.test(rel)) add(href, 'icon', svg ? 'Site icon (SVG)' : `Site icon${size ? ` ${size}px` : ''}`, svg ? 60 : size >= 96 ? 50 : 28);
  }
  // <meta property="og:image"> and friends
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attrs(m[1]), p = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (p === 'og:logo' || p === 'logo') add(a.content, 'image', 'Logo (page info)', 72);
    else if (p === 'og:image' || p === 'twitter:image') add(a.content, 'image', 'Sharing image', 14);
  }
  // JSON-LD "logo"
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const l of m[1].matchAll(/"logo"\s*:\s*(?:"([^"]+)"|\{[^}]*?"(?:url|contentUrl)"\s*:\s*"([^"]+)")/g)) add((l[1] || l[2]).replace(/\\\//g, '/'), 'image', 'Logo (page info)', 72);
  }
  // <img> that say "logo" (or the brand) in their file name, alt, class or id
  const imgs = [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = attrs(m[1]);
    const srcset = (a.srcset || a['data-srcset'] || '').split(',').map(s => s.trim().split(/\s+/)).filter(p => p[0]);
    const best = srcset.sort((x, y) => (parseFloat(y[1]) || 1) - (parseFloat(x[1]) || 1))[0]?.[0];
    const src = a.src && !a.src.startsWith('data:image/gif') ? a.src : a['data-src'] || best;
    if (!src) continue;
    const text = `${src} ${a.alt || ''} ${a.class || ''} ${a.id || ''} ${a.title || ''}`.toLowerCase();
    const isLogo = /logo|brand|wordmark/.test(text);
    const isBrand = brand.length > 2 && (a.alt || '').toLowerCase().includes(brand);
    if (isLogo || isBrand) imgs.push({ src, a, isLogo, isBrand, inHeader: m.index < headerEnd });
  }
  // many "logo" images below the header are usually a wall of customer logos, not the site's own
  const wall = imgs.filter(i => !i.inHeader && !i.isBrand).length >= 3;
  let wallKept = 0;
  for (const { src, a, isLogo, isBrand, inHeader } of imgs) {
    let score = (isLogo ? 70 : 52) + (inHeader ? 10 : 0) + (/\.svg(\?|$)/i.test(src) ? 6 : 0) + (isBrand ? 4 : 0);
    if (wall && !inHeader && !isBrand) { if (wallKept++ >= 2) continue; score = 20; }
    add(src, 'image', a.alt ? `Image: ${a.alt.slice(0, 40)}` : 'Logo image', score);
  }
  // inline <svg> marked as a logo (on the svg or on the element just before it)
  for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1).toLowerCase();
    const before = html.slice(Math.max(0, m.index - 300), m.index).toLowerCase();
    const isLogo = /logo|brand|wordmark/.test(open) || /(class|id|aria-label|title)\s*=\s*["'][^"']*(logo|brand|home)/.test(before.slice(before.lastIndexOf('<')));
    const isBrand = brand.length > 2 && open.includes(brand);
    if (!isLogo && !isBrand) continue;
    if (/<use\b[^>]*href\s*=\s*["']#/.test(m[0]) && !/<symbol\b/.test(m[0])) continue;   // points to a sprite elsewhere on the page
    addSvg(m[0], 'Logo drawing (SVG)', (m.index < headerEnd ? 78 : 64) + (isBrand ? 4 : 0));
  }
  add(page.origin + '/favicon.ico', 'icon', 'Favicon', 8);
  // a varied short list: at most 3 of each kind, so a page full of icons or customer logos
  // doesn't push the site's own app icon and favicon off the list
  const per = { svg: 0, image: 0, icon: 0 };
  return [...found.values()].sort((a, b) => b.score - a.score)
    .filter(c => per[c.kind]++ < 3).slice(0, 8);
}
