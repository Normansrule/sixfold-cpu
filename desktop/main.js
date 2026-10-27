// =============================================================================
// desktop/main.js: Sixfold as a desktop application (Electron)
//
// The website is a set of static files that use JavaScript modules. Browsers refuse to load modules from
// file://, so the files are served from a private scheme, app://sixfold/, registered as "standard" and
// "secure" (it behaves like an https origin). Nothing is fetched from the network: links to other sites
// open in the system browser.
//
//   npm start                       run from the repository (after npm run stage)
//   SIXFOLD_SMOKE=1 electron .      open each main page, report errors as JSON, exit 0 or 1 (used in CI);
//                                   SIXFOLD_SMOKE_OUT=file.json also writes the report to a file
// =============================================================================
'use strict';
const { app, BrowserWindow, Menu, protocol, shell, dialog, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'sixfold';
const ORIGIN = `${SCHEME}://${HOST}`;
const SITE = path.join(__dirname, 'app-site');
const SMOKE = process.env.SIXFOLD_SMOKE === '1';
// A smoke test runs on machines without a graphics card (CI, a virtual display): draw WebGL in software
if (SMOKE) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
const PAGES = {
  home: 'index.html',
  lab: 'web/index.html',
  isa: 'web/isa.html',
  workshop: 'web/custom.html',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8', '.s': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.sv': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------------------------------------------------------------- window size, remembered between runs
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); if (b.width > 400 && b.height > 300) return b; } catch { /* first run */ }
  return { width: 1360, height: 900 };
}
function saveBounds(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ }
}

// ---------------------------------------------------------------- serving the site
function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE + path.sep) && file !== SITE) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response(`not found: ${rel}`, { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return net.fetch(pathToFileURL(file).toString()).then(r => new Response(r.body, { status: 200, headers: { 'content-type': type } }));
}

// ---------------------------------------------------------------- windows and navigation
function isInternal(u) { try { return new URL(u).origin === ORIGIN; } catch { return false; } }
function openExternal(u) { try { const p = new URL(u).protocol; if (p === 'https:' || p === 'http:' || p === 'mailto:') shell.openExternal(u); } catch { /* ignore */ } }

function createWindow(page = PAGES.home) {
  const b = loadBounds();
  const win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y, minWidth: 420, minHeight: 360,
    title: 'Sixfold', backgroundColor: '#101B22', show: !SMOKE,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  if (b.maximized && !SMOKE) win.maximize();
  win.on('page-title-updated', e => { e.preventDefault(); win.setTitle(`Sixfold: ${win.webContents.getTitle()}`); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) { createWindow(new URL(url).pathname.replace(/^\//, '') + new URL(url).search); return { action: 'deny' }; }
    openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isInternal(url)) { e.preventDefault(); openExternal(url); } });
  win.on('close', () => saveBounds(win));
  win.loadURL(`${ORIGIN}/${page}`);
  return win;
}

function go(page) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.loadURL(`${ORIGIN}/${page}`); else createWindow(page);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const about = () => dialog.showMessageBox({
    type: 'info', title: 'About Sixfold', icon: path.join(__dirname, 'build', 'icon.png'),
    message: `Sixfold ${app.getVersion()}`,
    detail: 'An educational 6-stage 64-bit RISC-V CPU: the pipeline lab, three instruction sets, the instruction workshop and the documentation, offline.\n\nMIT license. Designed by Aleksander Norman.',
  });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Go', submenu: [
      { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => go(PAGES.home) },
      { label: 'Pipeline lab', accelerator: 'CmdOrCtrl+2', click: () => go(PAGES.lab) },
      { label: 'Three architectures', accelerator: 'CmdOrCtrl+3', click: () => go(PAGES.isa) },
      { label: 'Instruction workshop', accelerator: 'CmdOrCtrl+4', click: () => go(PAGES.workshop) },
      { type: 'separator' },
      { label: 'Back', accelerator: 'Alt+Left', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w && w.webContents.navigationHistory.canGoBack()) w.webContents.navigationHistory.goBack(); } },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w && w.webContents.navigationHistory.canGoForward()) w.webContents.navigationHistory.goForward(); } },
      { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Source on GitHub', click: () => openExternal('https://github.com/Normansrule/sixfold-cpu') },
      { label: 'Online version', click: () => openExternal('https://normansrule.github.io/sixfold-cpu/') },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'About Sixfold', click: about }]),
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- smoke test: every main page loads without errors
async function smoke() {
  const results = [];
  let errors = [];
  // one listener for the whole session (a second one would replace the first): failed requests of the page being tested
  const { session } = require('electron');
  session.defaultSession.webRequest.onCompleted({ urls: [`${ORIGIN}/*`] }, d => { if (d.statusCode >= 400) errors.push(`${d.statusCode} ${d.url}`); });
  const only = (process.env.SIXFOLD_SMOKE_PAGES || "").split(",").filter(Boolean); // e.g. lab,isa
  for (const [name, page] of Object.entries(PAGES).filter(([n]) => !only.length || only.includes(n))) {
    if (!fs.existsSync(path.join(SITE, page))) { results.push({ page, skipped: 'not in this build' }); continue; }
    errors = [];
    const win = createWindow(page);
    win.webContents.on('console-message', (...args) => {
      const e = args[0] && typeof args[0] === 'object' && 'level' in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (e.level === 'error' || e.level === 3) errors.push(String(e.message));
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push(`load failed ${code} ${desc} ${url}`));
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await new Promise(r => setTimeout(r, 2500)); // let the modules run
    const info = await win.webContents.executeJavaScript('({ title: document.title, modules: [...document.querySelectorAll("script[type=module]")].length, text: document.body.innerText.length })');
    // fonts come from Google Fonts: offline or blocked, that is expected and not an error of the app
    const real = errors.filter(e => !/fonts\.(googleapis|gstatic)\.com|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_PROXY/.test(e));
    results.push({ name, page, ...info, errors: real });
    win.destroy();
  }
  const ok = results.every(r => r.skipped || (r.errors.length === 0 && r.text > 100));
  const report = JSON.stringify({ ok, version: app.getVersion(), results }, null, 2) + '\n';
  process.stdout.write(report);
  if (process.env.SIXFOLD_SMOKE_OUT) try { fs.writeFileSync(process.env.SIXFOLD_SMOKE_OUT, report); } catch (e) { console.error(e); }
  app.exit(ok ? 0 : 1);
}

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    if (SMOKE) { smoke().catch(e => { console.error(e); app.exit(1); }); return; }
    if (!fs.existsSync(path.join(SITE, 'index.html'))) {
      dialog.showErrorBox('Sixfold', 'The site files are missing. Run "npm run stage" in the desktop folder first.');
      app.quit(); return;
    }
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !SMOKE) app.quit(); });
}
