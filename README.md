# Logo to Bricks

Turn any company logo into a brick sign you can really build: from a website address or a logo file, you get a 3D build animation, step-by-step PDF instructions and a parts list ready to order on LEGO Pick a Brick or BrickLink.

Based on [Punk to Bricks](https://github.com/hs7j4yk4sz-boop/punk-to-bricks) by John Karp (MIT): the 3D viewer, instruction booklet, video, order files and structural checks come from there. What's new is reading any logo, the standing-sign builder and the website logo finder.

**To put it online, follow [DEPLOY.md](DEPLOY.md).**

## How to use

1. **Type a website** (e.g. `pypi.org`) and click *Find logo*: the images that look like the site's logo appear as a row; the best one builds, click another to switch. Or **drop a logo file** (PNG, SVG, JPG, WebP, GIF, AVIF, ICO), or paste one.
2. **① Your sign**: pick **Mini** (1 pixel = 1 stud) or **XL** (1 pixel = 2×2 studs), **Panel** (logo standing proud of a board) or **Cut-out** (just the logo). Fine-tune **Detail** (pixels across), **Colours**, **Panel** colour and the **Name plate** text.
3. **② Instructions**: flip through the booklet, download the PDF or the full kit (PDF + parts CSV).
4. **③ Buy the bricks**: Pick a Brick upload file, BrickLink wanted list, and "only parts LEGO sells" to rebuild with parts LEGO stocks.

## How it works

| Step | File | What happens |
|---|---|---|
| Load | `src/input.ts` | Files are decoded in the browser. SVGs are cleaned (scripts, event handlers, outside links removed), given a pixel size and drawn through an `<img>`, where browsers never run scripts. |
| Read the logo | `src/core/logo.ts` | Find the background (transparent, a flat border colour, or none), crop to the logo, pick a grid size (~700 pixels by default, 12–64 wide), find the logo's colours (k-means in CIELAB, merge near-duplicates, drop anti-aliasing specks), vote one colour per cell, then map to the nearest of 37 brick colours (CIEDE2000) while keeping touching colours distinct. |
| Build | `src/core/build.ts`, `src/core/tile.ts` | Panel: the logo stands 1 stud (XL: 2) proud of a 2-stud (XL: 3) board with a one-pixel border. Cut-out: only the logo, 2 (XL: 4) studs deep; parts with nothing under them get clear support columns. Each layer is filled with real bricks, plates and tiles, alternating direction, **avoiding joints directly above joints** (staggered like masonry). The base grows deeper for tall signs. Anything left floating is repaired. |
| Check | `src/core/check.ts` | Studs connected, 0 floating, 0 collisions, centre of mass over the base, weak joints: shown on the page, never hidden. |
| Logo finder | `logo-api/worker.js` | A Cloudflare Worker that fetches a public page and lists logo candidates: `<img>` with *logo* in its name/alt/class, inline `<svg>` logos, JSON-LD `logo`, `og:logo`, app and site icons, favicon. Customer-logo walls are ranked down; the list is kept varied. |

## Security and privacy

Built to be safe to run in public with no account system and no secrets.

**The site** (static, GitHub Pages)
- Logo files never leave the browser.
- Strict Content Security Policy in the built page: scripts, workers and network calls only to the site itself and the logo finder; no plugins; no `<base>` tricks; no form posts.
  One deliberate exception: `style-src 'unsafe-inline'`, because SVG logos drawn from `blob:` URLs inherit the page's policy and many colour themselves with inline `<style>`. The page never inserts outside HTML, so there's no injection point for it to matter.
- Everything from the logo finder is treated as untrusted: shapes checked, URLs limited to `http(s)` or `data:image`, text inserted with `textContent`, never `innerHTML`.
- No cookies, analytics or trackers. Outbound links use `rel="noopener noreferrer"` and the page sends no referrer.
- Size limits on uploads (15 MB, 40 megapixels) so a hostile file can't freeze the tab.

**The logo finder** (Cloudflare Worker)
- Answers only origins listed in `ALLOWED_ORIGINS` (CORS), GET only.
- Per-IP rate limit (30/minute by default, `wrangler.toml`).
- **SSRF guards**: only `http(s)`, standard ports, no credentials in URLs, no IP addresses in any notation (decimal, hex, octal, IPv6), no `localhost` / `.local` / `.internal` / `.lan` names, no `127.0.0.1.nip.io`-style names. Redirects are followed by hand (max 4), each hop re-checked.
- 8-second timeouts; reads stop at 1.5 MB (pages) and 3 MB (images).
- `/image` returns only real images, recognised by their first bytes (not by what the remote server claims), with `nosniff`, `Content-Disposition: attachment` and a `sandbox` CSP, so an SVG can never run as a page on the Worker's domain.
- No logs of what people look up; successful answers cached at the edge for a day.

**Known limits**, stated plainly:
- A hostname that resolves to a private IP address passes the name checks (DNS isn't resolved in the Worker). Cloudflare's network can't reach your home or office network, and the Worker holds no secrets, so there's nothing behind it to reach, but it isn't a guarantee for other hosting.
- The allow list stops other *websites* from using your finder through visitors' browsers. A script outside a browser can fake the `Origin` header; the rate limit is what bounds that.
- Logos are trademarks. The FAQ and disclaimer say so; the tool doesn't try to stop anyone.

## Develop

```bash
npm ci
npm test            # 89 tests: logo reading, every example in every size/style, staggered joints, order files, logo finder guards
npm run dev         # http://localhost:5173
npm run build       # static site in dist/ (set VITE_LOGO_API to enable website search)
npm run check:ui    # browser smoke test of the built site with a faked logo finder (needs Chromium)
cd logo-api && npx wrangler dev   # the logo finder locally
```

The example logos in `public/examples` are made up (`npm run examples` redraws them). Tests draw their own made-up logos with a bundled free font.

## Notes

Unofficial fan project · Not affiliated with, sponsored or endorsed by the LEGO Group or BrickLink. LEGO® is a trademark of the LEGO Group. Logos belong to their owners. Parts data: [Rebrickable](https://rebrickable.com). No purchases, payments or personal data go through this site. Models are computer-checked, not physically build-tested.

## License

[MIT](LICENSE). See also the [disclaimer](DISCLAIMER.md). The license covers the code only, not any logo or trademark.
