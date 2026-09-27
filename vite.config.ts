import { defineConfig, loadEnv, type Plugin } from 'vite';

// A strict Content Security Policy for the built site: scripts, styles and
// workers only from this site; network calls only to this site and the logo
// finder; images only from this site or made in the page (blob:/data:).
function csp(api: string): Plugin {
  let origin = '';
  try { origin = api ? new URL(api).origin : ''; } catch { throw new Error(`VITE_LOGO_API is not a valid URL: ${api}`); }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' for styles only: SVG logos are drawn from blob: URLs, which inherit this
    // policy, and many logos colour themselves with inline <style>. The page itself never
    // inserts outside HTML, so there is nothing for injected CSS to ride on.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self'${origin ? ' ' + origin : ''}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'csp', apply: 'build',
    transformIndexHtml: html => html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`),
  };
}

// Relative base: the same build works on GitHub Pages (sub-path) and elsewhere.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: './',
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
    plugins: [csp(env.VITE_LOGO_API ?? process.env.VITE_LOGO_API ?? '')],
  };
});
