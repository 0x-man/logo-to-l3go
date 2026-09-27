// Browser smoke test of the built site (npm run build first; the logo finder is faked).
// node scripts/ui-check.cjs <outdir>
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const out = process.argv[2] || 'out';
fs.mkdirSync(out, { recursive: true });
const API = 'https://logo-to-bricks-api.example.workers.dev';
const PNG = fs.readFileSync('public/examples/quokka.png');
const SVG = fs.readFileSync('public/examples/peak.svg');

(async () => {
  const srv = spawn('npx', ['vite', 'preview', '--port', '4180', '--strictPort'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  // fake logo finder
  await page.route(API + '/**', async route => {
    const u = new URL(route.request().url());
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (u.pathname === '/find') return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'quokka.example', candidates: [
      { url: 'https://quokka.example/broken.png', kind: 'image', label: 'Broken image', score: 90 },
      { url: 'https://quokka.example/logo.svg', kind: 'image', label: 'Image: Quokka', score: 80 },
      { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="#C91A09" onload="alert(2)"/></svg>', kind: 'svg', label: 'Logo drawing (SVG)', score: 70 },
      { url: 'https://quokka.example/icon.png', kind: 'icon', label: 'App icon', score: 58 },
    ] }) });
    const target = u.searchParams.get('url') || '';
    if (target.endsWith('broken.png')) return route.fulfill({ status: 415, headers: { ...cors, 'Content-Type': 'application/json' }, body: '{"error":"no"}' });
    if (target.endsWith('.svg')) return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'image/svg+xml' }, body: SVG });
    return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'image/png' }, body: PNG });
  });
  page.on('dialog', d => { problems.push('dialog opened: ' + d.message()); d.dismiss(); });
  await page.goto('http://localhost:4180/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${out}/1-home.png` });

  // example → build
  await page.click('#examples button:nth-child(1)');
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
  await page.click('#skip');
  await page.waitForTimeout(800);
  await page.locator('#sec-bust').screenshot({ path: `${out}/2-sign-nordly.png` });
  const stats1 = await page.textContent('#stats');

  // cut-out + XL
  await page.click('[data-style="cutout"]');
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
  await page.click('#skip'); await page.waitForTimeout(600);
  await page.locator('#sec-bust').screenshot({ path: `${out}/3-cutout.png` });

  // website search
  await page.click('[data-style="panel"]');
  await page.fill('#site', 'quokka.example');
  await page.click('#site-go');
  await page.waitForFunction(() => document.querySelector('#found-title')?.textContent?.startsWith('Found on quokka.example. Not'), null, { timeout: 60000 });
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
  await page.click('#skip'); await page.waitForTimeout(600);
  await page.locator('#input-panel').screenshot({ path: `${out}/4-found.png` });
  const cands = await page.$$eval('.cand', bs => bs.map(b => [b.title, b.getAttribute('aria-checked')]));
  await page.locator('#sec-bust').screenshot({ path: `${out}/5-sign-from-site.png` });
  await page.locator('#sec-manual').screenshot({ path: `${out}/6-instructions.png` });
  await page.locator('#sec-buy').screenshot({ path: `${out}/7-buy.png` });

  // detail slider
  await page.fill('#detail', '20');
  await page.dispatchEvent('#detail', 'input');
  await page.waitForTimeout(600);
  await page.waitForSelector('#busy', { state: 'hidden', timeout: 60000 });
  const readText = await page.textContent('#read-text');

  // PDF download
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#dl-pdf')]);
  const pdfPath = `${out}/instructions.pdf`; await dl.saveAs(pdfPath);

  // phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: `${out}/8-phone.png`, fullPage: false });

  console.log(JSON.stringify({ stats1, cands, readText, pdf: fs.statSync(pdfPath).size, overflow, problems }, null, 1));
  await browser.close(); srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
