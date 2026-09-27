import type { BuildOptions, Model, SizeId, Style } from './core/build';
import type { LogoGrid, PixelizeOptions, RGBAImage } from './core/logo';
import { Viewer } from './viewer/scene';
import { brickLinkXML, partsCSV } from './export/parts';
import { brickLinkRemainderXML, orderSummary, pickABrickFiles } from './export/order';
import { icon } from './export/pdf';
import { BRICK_COLORS, COLOR_BY_ID, renderHex } from './core/palette';
import type { BuildReply, BuildRequest } from './worker/build.worker';
import { blobToImage, findLogos, loadCandidate, LOGO_API, thumb } from './input';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const worker = new Worker(new URL('./worker/build.worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const pending = new Map<number, (r: BuildReply) => void>();
worker.onmessage = (e: MessageEvent<BuildReply>) => { pending.get(e.data.id)?.(e.data); pending.delete(e.data.id); };
const build = (req: Omit<BuildRequest, 'id'>) => new Promise<BuildReply>(res => { const id = nextId++; pending.set(id, res); worker.postMessage({ ...req, id }); });

const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const viewer = new Viewer($('view'), { lowPoly: isPhone, label: '' });
viewer.onFinished = () => { $('hint').hidden = false; };

// ---------- state ----------
let source: RGBAImage | null = null;       // the logo picture, as loaded
let sourceName = '';                        // website or file name, for file names and the plate
let grid: LogoGrid | null = null;           // the logo as read at the current detail
const read: PixelizeOptions = { maxColors: 6, keepBackground: false };
let size: SizeId = 'mini';
let style: Style = 'panel';
let panel: number | 'auto' = 'auto';
let preferLego = false;
const models = new Map<string, Model>();    // for the current grid
const mkey = (s: SizeId, lego = preferLego) => `${s}|${lego}|${style}|${panel}`;
const opts = (lego = preferLego): BuildOptions => ({ style, panelColor: panel, preferLego: lego });

// ---------- input ----------
function showError(msg: string | null) { const e = $('error'); e.hidden = !msg; e.textContent = msg ?? ''; }
function busy(text: string | null) { $('busy').hidden = text === null; if (text) $('busy-text').textContent = text; }

async function start(img: RGBAImage, name: string) {
  source = img; sourceName = name;
  read.width = undefined;                  // new logo: pick the detail automatically
  const plate = $<HTMLInputElement>('plate-label');
  plate.value = plateFrom(name);
  viewer.setLabel(plateLabel());
  await reread(true);
}

/** Read the logo again (new picture or new reading settings), then build. */
async function reread(scroll = false) {
  if (!source) return;
  showError(null);
  $('result').hidden = false;
  if (scroll) $('sec-bust').scrollIntoView({ behavior: 'smooth', block: 'start' });
  busy('Reading your logo…');
  const r = await build({ size, image: source, read: { ...read }, opts: opts() });
  if (!r.ok) { busy(null); $('result').hidden = !grid; showError(r.message); return; }
  grid = r.grid;
  models.clear();
  models.set(mkey(size), r.model);
  drawGrid(r.grid);
  show(r.model, r.ms);
}

/** Build for the current size/style/panel (from cache if done before). */
async function rebuild() {
  if (!grid) return;
  const have = models.get(mkey(size));
  if (have) { show(have, 0); return; }
  busy(`Building the ${size === 'xl' ? 'XL' : 'Mini'} ${style === 'panel' ? 'sign' : 'cut-out'}${preferLego ? ' with parts LEGO sells' : ''}…`);
  const g0 = grid;
  const r = await build({ size, grid, opts: opts() });
  if (grid !== g0) return;
  if (!r.ok) { busy(null); showError(r.message); return; }
  models.set(mkey(size), r.model);
  show(r.model, r.ms);
}

function show(m: Model, ms: number) {
  busy(null);
  $('hint').hidden = true;
  viewer.setModel(m);
  viewer.setLabel(plateLabel());
  viewer.play();
  renderChecks(m, ms);
  renderBustSub();
  renderControls();
  $('secnav').hidden = false;
  renderBuy(m);
  renderReader(m);
}

// ---------- ① panels ----------
function drawGrid(g: LogoGrid) {
  const c = $<HTMLCanvasElement>('grid'), px = Math.max(2, Math.floor(160 / Math.max(g.w, g.h)));
  c.width = (g.w + 2) * px; c.height = (g.h + 2) * px;
  c.style.width = `${c.width / 2}px`;
  const x = c.getContext('2d')!;
  const m = current();
  x.fillStyle = m?.panelColor != null ? renderHex(m.panelColor) : '#ffffff'; x.fillRect(0, 0, c.width, c.height);
  g.cells.forEach((row, r) => row.forEach((v, col) => { if (v >= 0) { x.fillStyle = renderHex(g.colors[v].brick); x.fillRect((col + 1) * px, (r + 1) * px, px, px); } }));
  const bg = g.bgMode === 'transparent' ? 'transparent background' : g.bgMode === 'flat' ? 'flat background removed' : 'no background found: whole picture used';
  $('read-text').textContent = `${g.w} × ${g.h} pixels · ${g.colors.length} colour${g.colors.length > 1 ? 's' : ''}: ${g.colors.map(c2 => COLOR_BY_ID.get(c2.brick)!.name).join(', ')} · ${bg}`;
}
function renderControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.size === size)));
  document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.style === style)));
  $('panel-field').hidden = style !== 'panel';
  if (grid) {
    $<HTMLInputElement>('detail').value = String(grid.w);
    $('detail-out').textContent = `${grid.w} × ${grid.h}`;
  }
  $<HTMLSelectElement>('panel-color').value = String(panel);
  const m = current();
  const auto = $<HTMLSelectElement>('panel-color').options[0];
  auto.textContent = m?.panelColor != null && panel === 'auto' ? `Auto (${COLOR_BY_ID.get(m.panelColor)!.name})` : 'Auto';
}
function renderChecks(m: Model, ms: number) {
  const c = m.checks;
  const li = (cls: string, big: string, small: string) => `<li class="${cls}"><b>${big}</b>${small}</li>`;
  $('checks').innerHTML = [
    li('ok', `${c.connections.toLocaleString('en')} studs`, 'connected between pieces'),
    c.collisions === 0 ? li('ok', '0 collisions', 'no two pieces overlap') : li('bad', `${c.collisions} collisions`, 'some pieces overlap: this model can’t be built as is'),
    c.floating === 0 ? li('ok', '0 floating', 'every piece is attached to the base') : li('bad', `${c.floating} floating`, 'pieces not attached to the base: this model can’t be built as is'),
    c.com.inside ? li('ok', 'Balanced', `centre of mass ${c.com.margin} studs inside the base`) : li('bad', 'Will tip over', 'the centre of mass is outside the base'),
    c.weak === 0 ? li('ok', '0 weak joints', 'no piece hangs on a single stud') : li('warn', `${c.weak} weak joint${c.weak > 1 ? 's' : ''}`, 'held by a single stud: fine for display, handle gently'),
  ].join('');
  // notes are our own text (no user input), still set as text to be safe
  const notes = $('notes'); notes.textContent = '';
  for (const n of [...m.notes, `Computed in your browser${ms ? ` in ${(ms / 1000).toFixed(1)} s` : ''}. Computer-checked, not physically build-tested.`]) {
    const el = document.createElement('li'); el.textContent = n; notes.append(el);
  }
  const stat = (v: string, l: string) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  $('stats').innerHTML = stat(c.pieces.toLocaleString('en'), 'pieces') + stat(String(m.steps.length), 'steps')
    + stat(String(m.bom.length), 'lots to buy') + stat(`${m.dims[0]}×${m.dims[1]}×${m.dims[2]}`, 'cm');
  const solid = c.floating === 0 && c.collisions === 0 && c.com.inside;
  const pill = $('pill');
  pill.className = solid ? 'pill' : 'pill bad';
  pill.textContent = solid ? '✓ Checked: solid' : '✗ Check failed';
  $('status-short').textContent = `${c.floating} floating · ${c.collisions} collisions · ${c.com.inside ? 'balanced' : 'will tip over'}`;
}
function renderBustSub() {
  const m = current(); if (!m) return;
  $('bust-sub').textContent = `${sourceName ? `${sourceName} · ` : ''}${m.size === 'xl' ? 'XL' : 'Mini'} ${m.style === 'panel' ? 'panel sign' : 'cut-out'} · built and checked in your browser`;
}

// ---------- ① wiring ----------
const drop = $('drop'), file = $<HTMLInputElement>('file');
const openFile = (f: File) => blobToImage(f, f.name).then(img => { clearFound(); return start(img, f.name.replace(/\.[a-z0-9]+$/i, '')); },
  (e: Error) => showError(e.message && !/^(empty image|The source image)/.test(e.message) ? e.message : 'We couldn’t open this file. Use a PNG, SVG, JPG or WebP image.'));
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
file.addEventListener('change', () => { const f = file.files?.[0]; if (f) openFile(f); file.value = ''; });
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  const f = [...((e as DragEvent).dataTransfer?.files ?? [])].find(f2 => f2.type.startsWith('image/') || /\.(svg|ico)$/i.test(f2.name));
  if (f) openFile(f); else showError('That doesn’t look like an image. Drop a PNG, SVG or JPG of the logo.');
});
window.addEventListener('paste', e => {
  if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;   // pasting a web address into the box
  const f = [...(e.clipboardData?.files ?? [])].find(f2 => f2.type.startsWith('image/'));
  if (f) openFile(f);
});
document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach(b => b.addEventListener('click', () => { size = b.dataset.size as SizeId; renderControls(); rebuild(); }));
document.querySelectorAll<HTMLButtonElement>('[data-style]').forEach(b => b.addEventListener('click', () => { style = b.dataset.style as Style; renderControls(); rebuild(); }));
{
  const sel = $<HTMLSelectElement>('panel-color');
  for (const c of BRICK_COLORS) if (!c.trans) { const o = document.createElement('option'); o.value = String(c.id); o.textContent = c.name; sel.append(o); }
  sel.addEventListener('change', () => { panel = sel.value === 'auto' ? 'auto' : +sel.value; rebuild().then(() => grid && drawGrid(grid)); });
}
let detailTimer = 0;
$<HTMLInputElement>('detail').addEventListener('input', e => {
  const w = +(e.target as HTMLInputElement).value;
  $('detail-out').textContent = `${w} wide`;
  clearTimeout(detailTimer);
  detailTimer = window.setTimeout(() => { read.width = w; reread(); }, 350);
});
$<HTMLSelectElement>('ncolors').addEventListener('change', e => { read.maxColors = +(e.target as HTMLSelectElement).value; reread(); });
$<HTMLInputElement>('keep-bg').addEventListener('change', e => { read.keepBackground = (e.target as HTMLInputElement).checked; read.width = undefined; reread(); });
$('replay').addEventListener('click', () => { $('hint').hidden = true; viewer.play(); });
$('skip').addEventListener('click', () => viewer.skip());

/** Name plate text: printable characters only, 16 at most (it's drawn, never inserted as HTML). */
const cleanLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 16);
export const plateLabel = () => cleanLabel($<HTMLInputElement>('plate-label').value);
function plateFrom(name: string) {
  const host = name.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const word = host.includes('.') ? host.split('.').slice(0, -1).join('.') : host;
  const pretty = word.replace(/[-_]+/g, ' ').replace(/\s*(logo|icon|favicon|brand|mark|wordmark)(\s|$)/gi, ' ').trim();
  return cleanLabel(pretty ? pretty[0].toUpperCase() + pretty.slice(1) : '');
}
$('plate-label').addEventListener('input', () => viewer.setLabel(plateLabel()));

// ---------- website → candidates ----------
let findRun = 0;
function clearFound() { findRun++; $('found').hidden = true; $('found-row').textContent = ''; }
$('by-site').addEventListener('submit', async e => {
  e.preventDefault();
  const site = $<HTMLInputElement>('site').value.trim();
  if (!site) { showError('Type a website address, like example.com.'); return; }
  if (!LOGO_API) { showError('Website search isn’t set up on this copy of the site (see DEPLOY.md). Drop the logo file instead.'); return; }
  showError(null); clearFound();
  const run = findRun;
  const btn = $<HTMLButtonElement>('site-go'); btn.disabled = true; btn.textContent = 'Looking…';
  try {
    const { site: host, candidates } = await findLogos(site);
    if (run !== findRun) return;
    $('found').hidden = false;
    $('found-title').textContent = `Found on ${host}: loading ${candidates.length} image${candidates.length > 1 ? 's' : ''}…`;
    // load them all, show each as it arrives; build the best-ranked one that opens
    const state: ('wait' | 'ok' | 'fail')[] = candidates.map(() => 'wait');
    const picks: (() => void)[] = [];
    const seen = new Set<string>();
    let chosen = false, ok = 0;
    const autoPick = () => {
      if (chosen) return;
      for (let i = 0; i < state.length; i++) {
        if (state[i] === 'fail') continue;
        if (state[i] === 'ok') { chosen = true; picks[i](); }
        return;   // waiting on a better-ranked one
      }
    };
    await Promise.all(candidates.map(async (c, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cand'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
      b.title = c.label; b.disabled = true;
      const cap = document.createElement('small'); cap.textContent = c.label;
      $('found-row').append(b);
      try {
        const img = await loadCandidate(c);
        if (run !== findRun) return;
        if (img.width < 8 || img.height < 8) throw new Error('tiny');
        // the same picture twice (a page often repeats its logo): keep the first
        const fp = fingerprint(img);
        if (seen.has(fp)) throw new Error('duplicate');
        seen.add(fp);
        ok++; state[i] = 'ok';
        b.disabled = false;
        b.append(thumb(img), cap);
        picks[i] = () => {
          $('found-row').querySelectorAll('.cand').forEach(x => x.setAttribute('aria-checked', String(x === b)));
          start(img, host);
        };
        b.addEventListener('click', () => { chosen = true; picks[i](); });
      } catch { state[i] = 'fail'; b.remove(); }
      if (run === findRun) autoPick();
    }));
    if (run !== findRun) return;
    $('found-title').textContent = ok
      ? `Found on ${host}. Not the right one? Pick another${ok > 1 ? '' : ', or drop the file'}:`
      : `We found images on ${host} but couldn’t open any of them. Download the logo and drop the file instead.`;
  } catch (err) {
    if (run === findRun) showError((err as Error).message);
  } finally {
    btn.disabled = false; btn.textContent = 'Find logo';
  }
});
/** A tiny version of the picture, to spot duplicates. */
function fingerprint(img: RGBAImage): string {
  const d = thumb(img, 12).getContext('2d')!.getImageData(0, 0, 12, 12).data;
  let s = '';
  for (let i = 0; i < d.length; i += 4) s += d[i + 3] < 64 ? '.' : ((d[i] >> 6) * 16 + (d[i + 1] >> 6) * 4 + (d[i + 2] >> 6)).toString(36);
  return s;
}

// ---------- exports ----------
const current = () => models.get(mkey(size)) ?? null;
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const baseName = () => `${slug(plateLabel() || sourceName) || 'my-logo'}-${size}-${style}`;
function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
function progress(text: string | null, f = 0) {
  $('progress').hidden = text === null;
  if (text !== null) { $('progress-text').textContent = text; $('bar').style.width = `${Math.round(f * 100)}%`; }
}
let exporting = false;
const busyButtons = () => document.querySelectorAll<HTMLButtonElement>('.act, .vid-btn, .ctab');
async function run(label: string, job: () => Promise<void>) {
  if (exporting || !current()) return;
  exporting = true;
  busyButtons().forEach(b => { b.disabled = true; });
  try { await job(); progress(null); }
  catch (e) { progress(`${label} failed: ${(e as Error).message}`, 0); setTimeout(() => progress(null), 6000); }
  finally { exporting = false; busyButtons().forEach(b => { b.disabled = false; }); }
}

// ---------- ② instructions reader: pages are drawn only when looked at ----------
type Maker = import('./export/pdf').PageMaker;
let maker: Maker | null = null, makerFor: Model | null = null, pageNo = 1;
let thumbObserver: IntersectionObserver | null = null;
async function renderReader(m: Model) {
  const { PageMaker } = await import('./export/pdf');
  if (current() !== m) return;
  maker?.dispose();
  maker = new PageMaker(m, grid!, { label: plateLabel(), renderSize: isPhone ? 800 : 1000 });
  makerFor = m;
  const range = $<HTMLInputElement>('pg-range');
  range.max = String(maker.total);
  $('manual-sub').textContent = `${m.steps.length} steps · ${maker.total} pages · one page per layer`;
  $('pdf-note').textContent = `PDF · ${maker.total} pages`;
  thumbObserver?.disconnect();
  const strip = $('thumbs'); strip.innerHTML = '';
  const queue: number[] = [];
  let drawing = false;
  const drain = () => {
    if (drawing || !queue.length || !maker) return;
    drawing = true;
    const n = queue.shift()!, c = strip.querySelector<HTMLCanvasElement>(`[data-n="${n}"] canvas`);
    setTimeout(() => {
      if (c && maker && makerFor === m) c.getContext('2d')!.drawImage(maker.page(n), 0, 0, c.width, c.height);
      drawing = false; drain();
    }, 0);
  };
  thumbObserver = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const n = +(e.target as HTMLElement).dataset.n!;
    thumbObserver!.unobserve(e.target); queue.push(n); drain();
  }), { root: strip, rootMargin: '0px 240px' });
  for (let n = 1; n <= maker.total; n++) {
    const b = document.createElement('button');
    b.dataset.n = String(n);
    const c = document.createElement('canvas'); c.width = 224; c.height = 158;
    b.append(c, maker.label(n));
    b.addEventListener('click', () => showPage(n));
    strip.append(b); thumbObserver.observe(b);
  }
  showPage(1);
}
function showPage(n: number) {
  if (!maker) return;
  pageNo = Math.max(1, Math.min(maker.total, n));
  const c = $<HTMLCanvasElement>('page-canvas');
  c.getContext('2d')!.drawImage(maker.page(pageNo), 0, 0, c.width, c.height);
  $<HTMLInputElement>('pg-range').value = String(pageNo);
  $('pg-label').textContent = `${maker.label(pageNo)}${pageNo > 1 && pageNo <= maker.steps + 1 ? ` of ${maker.steps}` : ''}`;
  $<HTMLButtonElement>('pg-prev').disabled = pageNo === 1;
  $<HTMLButtonElement>('pg-next').disabled = pageNo === maker.total;
  const strip = $('thumbs');
  strip.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.n! === pageNo));
  const on = strip.querySelector<HTMLElement>(`[data-n="${pageNo}"]`);
  if (on) strip.scrollTo({ left: on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2, behavior: 'smooth' });
}
$('pg-prev').addEventListener('click', () => showPage(pageNo - 1));
$('pg-next').addEventListener('click', () => showPage(pageNo + 1));
$('pg-range').addEventListener('input', e => showPage(+(e.target as HTMLInputElement).value));
$('page-view').tabIndex = 0;
$('page-view').addEventListener('keydown', e => { if (e.key === 'ArrowRight') showPage(pageNo + 1); if (e.key === 'ArrowLeft') showPage(pageNo - 1); });
{ // swipe on phones
  let x0: number | null = null;
  $('page-view').addEventListener('pointerdown', e => { x0 = e.clientX; });
  $('page-view').addEventListener('pointerup', e => { if (x0 !== null && Math.abs(e.clientX - x0) > 40) showPage(pageNo + (e.clientX < x0 ? 1 : -1)); x0 = null; });
}
let labelTimer = 0;
$('plate-label').addEventListener('input', () => {
  clearTimeout(labelTimer);
  labelTimer = window.setTimeout(() => { const m = current(); if (m) { const keep = pageNo; renderReader(m).then(() => showPage(keep)); } renderBustSub(); }, 500);
});
$('dl-pdf').addEventListener('click', () => run('Instructions', async () => {
  const { makeInstructions } = await import('./export/pdf');
  progress('Drawing the instructions…', 0);
  const pdf = await makeInstructions(current()!, grid!, { label: plateLabel(), renderSize: isPhone ? 800 : 1100, onProgress: (d, t) => progress(`Drawing page ${d} of ${t}…`, d / t) });
  save(pdf, `${baseName()}-instructions.pdf`);
}));
$('dl-kit').addEventListener('click', () => run('Kit', async () => {
  const [{ makeInstructions }, { makeZip }] = await Promise.all([import('./export/pdf'), import('./export/zip')]);
  const m = current()!, name = baseName();
  progress('Drawing the instructions…', 0);
  const pdf = await makeInstructions(m, grid!, { label: plateLabel(), renderSize: isPhone ? 800 : 1100, onProgress: (d, t) => progress(`Drawing page ${d} of ${t}…`, d / t) });
  const readme = [`${name} — made with Logo to Bricks`, '', `${m.checks.pieces} pieces · ${m.steps.length} steps · ${m.bom.length} lots · about ${m.dims.join(' × ')} cm`, '',
    `${name}-instructions.pdf   step-by-step instructions, one page per layer`, `${name}-parts.csv   parts list (BrickLink part and colour numbers)`, '',
    'To order the bricks, use "Buy the bricks" on the site: it makes your LEGO Pick a Brick and BrickLink lists.', '',
    'Models are generated automatically and checked by software only. They have NOT been physically built. Provided "as is", without warranty of any kind.',
    'Logos are trademarks of their owners: build for yourself, or with the owner\'s permission.',
    'Unofficial fan project · Not affiliated with, sponsored or endorsed by the LEGO Group or BrickLink. LEGO® is a trademark of the LEGO Group. Parts data: Rebrickable.', ''].join('\r\n');
  save(await makeZip([{ name: `${name}-instructions.pdf`, data: pdf }, { name: `${name}-parts.csv`, data: partsCSV(m) }, { name: 'README.txt', data: readme }]), `${name}-kit.zip`);
}));
for (const format of ['square', 'story'] as const) $(format === 'square' ? 'vid-square' : 'vid-story').addEventListener('click', () => run('Video', async () => {
  const { recordVideo } = await import('./export/video');
  progress('Preparing the booklet pages…', 0);
  const { blob, ext } = await recordVideo(current()!, grid!, { format, label: plateLabel(), small: isPhone,
    onProgress: (stage, f) => progress(stage === 'pages' ? 'Preparing the booklet pages…' : 'Recording the video (24 s)… keep this tab open', f) });
  save(blob, `${baseName()}-${format === 'story' ? '9x16' : 'square'}.${ext}`);
}));

// ---------- ③ buy the bricks ----------
function renderBuy(m: Model) {
  const s = orderSummary(m), total = m.bom.length, pcs = m.checks.pieces.toLocaleString('en');
  const legoSet = new Set(s.lego.map(l => `${l.part}|${l.color}`));
  $('shop-sum').textContent = `${total} lots · ${pcs} pieces · BrickLink part numbers`;
  const g = $('shop-grid'); g.innerHTML = '';
  for (const b of m.bom) {
    const lot = document.createElement('div'); lot.className = 'lot';
    const at = legoSet.has(`${b.part}|${b.color}`);
    lot.title = `${b.qty}× ${b.name}, ${b.colorName} (${b.part}) · ${at ? 'at LEGO Pick a Brick' : 'BrickLink only'}`;
    const c = document.createElement('canvas'); c.width = 112; c.height = 88;
    icon(c.getContext('2d')!, 56, 44, b.d, b.w, renderHex(b.color), 96, b.kind);
    const dot = document.createElement('i'); dot.className = `dot ${at ? 'lego' : 'bl'}`;
    const t = document.createElement('span');
    t.innerHTML = `<span class="q">${b.qty}x</span><small>${b.name}</small><small>${b.colorName}</small>`;
    lot.append(dot, c, t); g.append(lot);
  }
  const more = $('shop-more');
  more.hidden = total <= 8;
  $('shoplist').classList.toggle('open', false);
  more.textContent = `See all ${total} lots ▾`;
  $('lego-n').textContent = String(s.lego.length);
  $('lego-total').textContent = `/${total} lots`;
  $<HTMLButtonElement>('buy-lego').disabled = s.lego.length === 0;
  $('lego-guide').hidden = true;
  const other = models.get(mkey(size, !preferLego));
  const delta = other ? (preferLego ? m.checks.pieces - other.checks.pieces : other.checks.pieces - m.checks.pieces) : null;
  const plus = delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta} pieces)`;
  $('lego-option').hidden = !preferLego && s.brickLinkOnly.length === 0;
  $('prefer-text').textContent = preferLego
    ? `Only parts LEGO sells: on${plus}, every check passed again`
    : `Get all ${total} lots at LEGO: use only parts LEGO sells${plus}`;
  $<HTMLInputElement>('prefer-lego').checked = preferLego;
  const missing = s.brickLinkOnly.length;
  $('bl-n').textContent = String(missing || total);
  $('bl-total').textContent = `/${total} lots`;
  $('bl-sub').textContent = missing ? 'Independent shops · the rest' : 'Independent shops · if LEGO runs out';
  $('bl-after').hidden = true;
  $('bl-option').hidden = missing === 0;
  $('copy-all').textContent = `copy all ${total} lots`;
  const files = pickABrickFiles(m).length;
  $('pab-files').textContent = files > 1 ? `${files} files, 400 references each at most` : 'one CSV file';
  $('dl-xml-rest').hidden = missing === 0;
  // how many extra pieces "only parts LEGO sells" would cost: build it in the background
  if (!preferLego && missing && !other && grid) {
    const g0 = grid, s0 = size, k = mkey(size, true), o = opts(true);
    build({ size: s0, grid: g0, opts: o }).then(r => { if (r.ok && grid === g0) { models.set(k, r.model); if (current() === m) renderBuy(m); } });
  }
}
$('shop-more').addEventListener('click', () => {
  const open = $('shoplist').classList.toggle('open');
  $('shop-more').textContent = open ? 'Show less ▴' : `See all ${current()?.bom.length ?? ''} lots ▾`;
});
let understood = false;
function beforeOrder(): Promise<boolean> {
  if (understood) return Promise.resolve(true);
  const d = $<HTMLDialogElement>('before-order'), ok = $<HTMLInputElement>('bo-ok'), go = $<HTMLButtonElement>('bo-continue');
  ok.checked = false; go.disabled = true;
  ok.onchange = () => { go.disabled = !ok.checked; };
  d.showModal();
  return new Promise(res => { d.onclose = () => { understood = d.returnValue === 'ok' && ok.checked; res(understood); }; });
}
async function orderAction(make: (m: Model) => void | Promise<void>) {
  const m = current();
  if (m && await beforeOrder()) await make(m);
}
const downloadLego = (m: Model) => {
  const files = pickABrickFiles(m);
  files.forEach((f, i) => setTimeout(() => save(new Blob([f], { type: 'text/csv' }), `${baseName()}-pick-a-brick${files.length > 1 ? `-${i + 1}-of-${files.length}` : ''}.csv`), i * 400));
  return files.length;
};
async function copyOrSave(xml: string, name: string): Promise<'copied' | 'downloaded'> {
  try { await navigator.clipboard.writeText(xml); return 'copied'; }
  catch { save(new Blob([xml], { type: 'application/xml' }), name); return 'downloaded'; }
}
$('buy-lego').addEventListener('click', () => orderAction(m => {
  const n = downloadLego(m);
  $('lego-file').textContent = n > 1
    ? `${n} files saved to your Downloads (${baseName()}-pick-a-brick-1-of-${n}.csv …): upload them one after the other`
    : `${baseName()}-pick-a-brick.csv · saved to your Downloads`;
  const g = $('lego-guide'); g.hidden = false;
  g.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}));
$('lego-again').addEventListener('click', () => orderAction(m => { downloadLego(m); }));
async function buyBrickLink(all: boolean) {
  await orderAction(async m => {
    const missing = orderSummary(m).brickLinkOnly.length;
    const everything = all || missing === 0;
    const how = await copyOrSave(everything ? brickLinkXML(m) : brickLinkRemainderXML(m), `${baseName()}-bricklink${everything ? '' : '-missing'}.xml`);
    const lots = everything ? m.bom.length : missing;
    $('bl-after-text').textContent = how === 'copied' ? `List copied (${lots} of ${m.bom.length} lots)` : `Couldn’t copy: list downloaded instead (open it and copy its text)`;
    $('bl-after').hidden = false;
  });
}
$('buy-bl').addEventListener('click', () => buyBrickLink(false));
$('copy-all').addEventListener('click', () => buyBrickLink(true));
$('dl-pab').addEventListener('click', () => orderAction(m => { downloadLego(m); }));
$('dl-xml').addEventListener('click', () => orderAction(m => save(new Blob([brickLinkXML(m)], { type: 'application/xml' }), `${baseName()}-bricklink.xml`)));
$('dl-xml-rest').addEventListener('click', () => orderAction(m => save(new Blob([brickLinkRemainderXML(m)], { type: 'application/xml' }), `${baseName()}-bricklink-missing.xml`)));
$('prefer-lego').addEventListener('change', e => {
  preferLego = (e.target as HTMLInputElement).checked;
  $('prefer-text').textContent = 'Rebuilding with parts LEGO sells and checking again…';
  rebuild();
});

// ---------- sticky section menu ----------
const secLinks = [...document.querySelectorAll<HTMLAnchorElement>('#secnav a')];
const secObserver = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) secLinks.forEach(a => a.classList.toggle('on', a.dataset.sec === e.target.id));
}, { rootMargin: '-45% 0px -50% 0px' });
['sec-bust', 'sec-manual', 'sec-buy'].forEach(id => secObserver.observe($(id)));

// ---------- made-up example logos (public/examples, no real brands) ----------
const examples = [
  { file: 'nordly.png', title: 'Nordly (wordmark)' },
  { file: 'quokka.png', title: 'Quokka (app icon)' },
  { file: 'rings.png', title: 'Bullseye (rings)' },
  { file: 'go.png', title: 'Gradient badge' },
  { file: 'peak.svg', title: 'Peak (SVG)' },
];
for (const ex of examples) {
  const b = document.createElement('button');
  b.title = ex.title;
  const img = document.createElement('img');
  img.src = `./examples/${ex.file}`; img.alt = ex.title; img.width = img.height = 44;
  b.append(img);
  b.addEventListener('click', () => fetch(`./examples/${ex.file}`).then(r => r.blob()).then(bl => blobToImage(bl, ex.file))
    .then(im => { clearFound(); return start(im, ex.title.split(' (')[0]); }, () => showError('We couldn’t load this example.')));
  $('examples').append(b);
}
if (!LOGO_API) $('site-help').textContent = 'Website search needs the logo finder (see DEPLOY.md). Dropping a file works now.';
renderControls();

// dev/test hook: lets scripts drive the page
if (import.meta.env.DEV) Object.assign(window, { ltb: { viewer, start, blobToImage, setSize: (s: SizeId) => { size = s; rebuild(); } } });
