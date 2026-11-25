'use strict';
const { app, BrowserWindow, ipcMain, protocol, session, net, screen, clipboard, dialog, Menu, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const { realpathSync, mkdirSync, existsSync, copyFileSync, constants } = require('node:fs');
const { homedir } = require('node:os');
const { resolve, sep, extname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const { trustedSender } = require('./contract.cjs');
const { DesktopUpdater, checkStartupRollbackSync } = require('./updater.cjs');
const sessionsProfile = process.argv.includes('--lab-sessions');
const deviceSlot = process.argv.find(arg => /^--lab-device=[ab]$/.test(arg))?.at(-1);
const installedWindows = process.platform === 'win32' && existsSync(resolve(process.resourcesPath, 'tools/node.exe'));
const windowsDevice = installedWindows || (process.platform === 'win32' && process.argv.includes('--lab-windows'));
const installedLinux = process.platform === 'linux' && existsSync(resolve(process.resourcesPath, 'tools/node'));
const linuxDesktop = installedLinux || (process.platform === 'linux' && process.argv.includes('--desktop-linux'));
const standaloneDevice = windowsDevice || linuxDesktop;
const windowsRoot = windowsDevice ? resolve(process.env.LOCALAPPDATA, 'AnywhereMesh') : null;
const linuxRoot = linuxDesktop ? resolve(process.env.ANYWHERE_MESH_DATA_DIR || resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local/share'), 'AnywhereMesh')) : null;
const wanProfile = deviceSlot && process.argv.includes('--lab-wan');
const appDir = deviceSlot || standaloneDevice ? resolve(__dirname,'../account-devices') : sessionsProfile ? resolve(__dirname, '../desktop-sessions') : __dirname;
const packageRootDir = resolve(__dirname, '../..');
const contract = require(resolve(appDir, 'contract.cjs'));
const validate = contract.internalValidate ?? contract.validate;
const validatePublic = contract.publicValidate ?? contract.validate;
let testPickerPath;
let pickingWorkspace=false;
let updater = null;
let windowLoaded = false;

if (installedWindows || installedLinux) {
  const rollback = checkStartupRollbackSync({
    dataRoot: installedWindows ? windowsRoot : linuxRoot,
    appDir: packageRootDir,
    currentVersion: app.getVersion(),
  });
  if (rollback.rolledBack) {
    app.relaunch();
    app.exit(0);
  }
}

if (standaloneDevice) {
  if (sessionsProfile || deviceSlot) throw Error('STANDALONE_PROFILE_REQUIRED');
} else if (process.platform !== 'linux' || !existsSync('/etc/anywhere-crossborder-lab')) throw Error('LAB_LINUX_REQUIRED');
const profile = windowsDevice ? resolve(windowsRoot,'profile') : linuxDesktop ? resolve(linuxRoot, 'profile') : deviceSlot ? '/srv/anywhere-lab/'+(wanProfile ? 'wan' : 'd3')+'/shell-'+deviceSlot :
  sessionsProfile ? '/srv/anywhere-lab/desktop-d2/shell-profile' : '/srv/anywhere-lab/desktop-d/shell-profile';
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setName('AnywhereMesh');
app.disableHardwareAcceleration();
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'anywhere-desktop', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
let win, child, stopping, childExited = false, allowQuit = false, nextId = 1, backendReady = false;
const pending = new Map();
const single = app.requestSingleInstanceLock();
if (!single) { allowQuit = true; app.quit(); }
function request(method, params) {
  validate(method, params);
  if (!child || childExited || stopping) return Promise.reject(Error('DESKTOP_BACKEND_UNAVAILABLE'));
  if (pending.size >= 16) return Promise.reject(Error('TOO_MANY_REQUESTS'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('DESKTOP_REQUEST_TIMEOUT')); }, standaloneDevice && (method === 'login' || method === 'state') ? 65000 : 40000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (!child || childExited) return;
    child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('BACKEND_STOP_TIMEOUT')), 70000);
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('BACKEND_STOP_FAILED')); });
    });
  })(); return stopping;
}
if (single) app.whenReady().then(async () => {
  if (installedWindows) {
    app.setAppUserModelId('AnywhereMesh.Desktop');
    mkdirSync(resolve(windowsRoot,'project'), {recursive:true});
    if (!existsSync(resolve(windowsRoot,'ca.crt'))) {
      copyFileSync(resolve(process.resourcesPath,'tools/ca.crt'),resolve(windowsRoot,'ca.crt'),constants.COPYFILE_EXCL);
    }
  }
  if (installedLinux) {
    mkdirSync(resolve(linuxRoot, 'project'), { recursive: true, mode: 0o700 });
    if (!existsSync(resolve(linuxRoot, 'ca.crt'))) {
      copyFileSync(resolve(process.resourcesPath, 'tools/ca.crt'), resolve(linuxRoot, 'ca.crt'), constants.COPYFILE_EXCL);
    }
  }
  const assets = realpathSync(resolve(appDir, deviceSlot || standaloneDevice ? 'ui' : 'dist'));
  protocol.handle('anywhere-desktop', async req => {
    try {
      const u = new URL(req.url);
      if (req.method !== 'GET' || u.host !== 'app' || u.username || u.password || u.search || u.hash) return new Response('Denied', { status: 403 });
      const path = realpathSync(resolve(assets, '.' + decodeURIComponent(u.pathname)));
      if (!path.startsWith(assets + sep) || !['.html', '.css', '.js', '.svg', '.png', '.woff2', '.webmanifest'].includes(extname(path))) return new Response('Denied', { status: 403 });
      return net.fetch(pathToFileURL(path).href);
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  const backend = installedWindows ? resolve(process.resourcesPath,'tools/node.exe') :
    windowsDevice ? resolve(windowsRoot,'runtime/node.exe') :
    installedLinux ? resolve(process.resourcesPath, 'tools/node') :
    linuxDesktop ? (process.env.ANYWHERE_MESH_NODE || process.execPath) : '/usr/local/bin/node';
  const linuxEnv = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'TMPDIR',
      'ANYWHERE_MESH_DATA_DIR', 'ANYWHERE_MESH_URL', 'ANYWHERE_MESH_CA', 'ANYWHERE_MESH_EASYTIER',
      'ANYWHERE_MESH_NAME', 'ANYWHERE_MESH_USE_PROXY']
      .filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
  );
  const env = windowsDevice ? Object.fromEntries(['SystemRoot','WINDIR','LOCALAPPDATA','USERPROFILE','TEMP','TMP'].map(k=>[k,process.env[k]])) :
    linuxDesktop ? linuxEnv : { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/lab', LANG: 'C.UTF-8' };
  const controllerScript = windowsDevice ? 'windows/controller.mjs' : linuxDesktop ? 'linux/controller.mjs' : 'controller.mjs';
  child = spawn(backend, [resolve(appDir, controllerScript), ...(deviceSlot ? [deviceSlot] : []), ...(wanProfile ? ['wan'] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...env, NODE_NO_WARNINGS: '1' },
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const lines = createInterface({ input: child.stdout });
  const maybeMarkHealthy = () => {
    if (backendReady && windowLoaded && updater) updater.markBootHealthy();
  };
  lines.on('line', line => {
    if (line.length > 2 * 1024 * 1024) { child.stdin.end(); return; }
    let msg; try { msg = JSON.parse(line); } catch { child.stdin.end(); return; }
    if (msg.event === 'ready') { backendReady = true; maybeMarkHealthy(); }
    if (msg.event === 'stream' && win && !win.isDestroyed()) { win.webContents.send('desktop:event', msg.data); return; }
    if (!msg.id) return;
    const waiter = pending.get(msg.id); if (!waiter) return;
    pending.delete(msg.id); clearTimeout(waiter.timer);
    msg.error ? waiter.reject(Error(msg.error)) : waiter.resolve(msg.value);
  });
  if (standaloneDevice) {
    const dataRoot = windowsDevice ? windowsRoot : linuxRoot;
    const installDir = (installedWindows || installedLinux) ? resolve(process.resourcesPath, '..') : null;
    const relaunchExe = installedWindows ? process.execPath :
      installedLinux ? resolve(process.resourcesPath, '../bin/anywhere-mesh') : process.execPath;
    updater = new DesktopUpdater({
      dataRoot,
      appDir: packageRootDir,
      installDir,
      nodeBin: backend,
      relaunchExe,
      canInstall: installedWindows || installedLinux || process.env.ANYWHERE_MESH_UPDATE_ALLOW_DEV === '1',
      getExtraPids: () => (child?.pid ? [child.pid] : []),
      onStateChange: snap => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('desktop:event', { type: 'update_state', payload: snap });
        }
      },
      requestQuit: () => app.quit(),
    });
    void updater.init().catch(e => console.error('Desktop updater init:', e.message));
  }
  child.once('exit', () => {
    childExited = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('DESKTOP_BACKEND_EXITED')); }
    pending.clear();
    if (!stopping) app.quit();
  });
  child.on('error', e => console.error('Desktop backend:', e.message));
  const area = screen.getPrimaryDisplay().workAreaSize;
  const iconPath = installedWindows ? resolve(process.resourcesPath, 'AnywhereMesh.ico') :
    installedLinux ? resolve(process.resourcesPath, 'AnywhereMesh.png') : null;
  win = new BrowserWindow({ width: Math.min(area.width, 1280), height: Math.min(area.height, 900), minWidth: 900, minHeight: 680,
    show: false, backgroundColor: standaloneDevice || deviceSlot ? (nativeTheme.shouldUseDarkColors ? '#1c201d' : '#fdfdfa') : '#09090b',
    title: 'AnywhereMesh', autoHideMenuBar: true,
    ...(iconPath && existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { preload: resolve(appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  if (standaloneDevice) win.webContents.on('context-menu', (_event, params) => {
    const {editFlags, isEditable, selectionText, frame, x, y}=params;
    if (!isEditable && !selectionText) return;
    const items=[];
    if (isEditable) items.push({role:'cut',label:'剪切',enabled:editFlags.canCut});
    items.push(selectionText ? {
      label:'复制',enabled:editFlags.canCopy,
      async click() {
        // The menu can take focus away from the selected message or input.
        try {await clipboard.writeText(selectionText);}
        catch {console.error('Desktop clipboard copy failed');}
      }
    } : {role:'copy',label:'复制',enabled:editFlags.canCopy});
    if (isEditable) items.push({role:'paste',label:'粘贴',enabled:editFlags.canPaste},
      {role:'selectAll',label:'全选',enabled:editFlags.canSelectAll});
    Menu.buildFromTemplate(items).popup({window:win,frame:frame??undefined,x,y,sourceType:params.menuSourceType});
  });
  ipcMain.handle('desktop:request', async (event, method, params) => {
    if (!trustedSender(event, win?.webContents)) throw Error('UNTRUSTED_DESKTOP_SENDER');
    validatePublic(method, params);
    if (method === 'updateStatus') return updater ? updater.snapshot() : { supported: false };
    if (method === 'updateCheck') return updater ? updater.check({ manual: params?.manual !== false }) : { supported: false };
    if (method === 'updateDownload') return updater ? updater.download() : { supported: false };
    if (method === 'updateCancel') return updater ? updater.cancelDownload() : { supported: false };
    if (method === 'updateInstall') return updater ? updater.prepareInstall({ relaunch: params?.relaunch !== false }) : { supported: false };
    if (method === 'updateSettings') return updater ? updater.updateSettings(params) : { supported: false };
    if (method === 'updateDismiss') return updater ? updater.dismissVersion(params.version) : { supported: false };
    if (standaloneDevice && method === 'chooseAttachment') {
      const picked = await dialog.showOpenDialog(win, { title: '选择附件', buttonLabel: '添加附件',
        properties: ['openFile', 'dontAddToRecent'] });
      return picked.canceled || !picked.filePaths[0] ? null : request('uploadAttachmentFile', { sessionId: params.sessionId, path: picked.filePaths[0] });
    }
    if (standaloneDevice && method === 'chooseWorkspace') {
      if (pickingWorkspace) return null;
      pickingWorkspace=true;
      try {
        const picked=await dialog.showOpenDialog(win,{title:'选择本机项目文件夹',buttonLabel:'选择文件夹',
          properties:['openDirectory','dontAddToRecent']});
        return picked.canceled || !picked.filePaths[0] ? null : request('registerWorkspace',{path:picked.filePaths[0]});
      } finally { pickingWorkspace=false; }
    }
    if (sessionsProfile && method === 'chooseWorkspace') {
      const picked = testPickerPath && process.argv.includes('--lab-sessions-smoke') ? { canceled: false, filePaths: [testPickerPath] } :
        await dialog.showOpenDialog(win, { title: '选择本地项目（实验目录）', defaultPath: '/srv/anywhere-lab/desktop-d2/projects',
          buttonLabel: '添加项目', properties: ['openDirectory', 'dontAddToRecent'] });
      testPickerPath = undefined;
      return picked.canceled ? request('state', {}) : request('registerWorkspace', { path: picked.filePaths[0] });
    }
    return request(method, params);
  });
  win.once('ready-to-show', () => {
    windowLoaded = true;
    maybeMarkHealthy();
    win.show();
  });
  win.on('focus', () => updater?.onWindowFocus());
  win.on('closed', () => { win = null; });
  await win.loadURL('anywhere-desktop://app/index.html');
  if (updater && win && !win.isDestroyed()) {
    win.webContents.send('desktop:event', { type: 'update_state', payload: updater.snapshot() });
  }
  if (windowsDevice && !installedWindows && process.argv.includes('--lab-windows-smoke')) {
    const { smoke } = await import('../account-devices/windows/smoke.mjs');
    smoke({win,root:windowsRoot}).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>app.quit());
  }
  if (deviceSlot === 'b' && process.argv.includes('--lab-device-smoke')) {
    const { smoke } = await import('../account-devices/lab/gui.mjs');
    smoke({app,win,BrowserWindow,session,wan:wanProfile}).catch(e=>{console.error(e.message);process.exitCode=1;app.quit();});
  }
  if (sessionsProfile && process.argv.includes('--lab-sessions-smoke')) {
    const { smoke } = await import('../desktop-sessions/lab/ui-smoke.mjs');
    smoke({ app, win, request, ready: () => backendReady, pick: path => { testPickerPath = path; } }).catch(e => { console.error(e.stack); app.quit(); });
  }
  if (sessionsProfile && process.argv.includes('--lab-sessions-crash-smoke')) {
    const { crashSmoke } = await import('../desktop-sessions/lab/crash-smoke.mjs');
    crashSmoke({ request, ready: () => backendReady, backendPid: child.pid }).catch(e => { console.error(e.stack); process.exitCode = 1; app.quit(); });
  }
  if (process.argv.includes('--lab-smoke')) {
    const { smoke } = await import('./lab/ui-smoke.mjs');
    smoke({ app, win, request, ready: () => backendReady }).catch(e => { console.error(e.stack); process.exitCode = 1; app.quit(); });
  }
  if (process.argv.includes('--lab-crash-smoke')) {
    const { crashSmoke } = await import('./lab/crash-smoke.mjs');
    crashSmoke({ request, ready: () => backendReady, backendPid: child.pid }).catch(e => { console.error(e.stack); process.exitCode = 1; app.quit(); });
  }
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
process.once('SIGTERM', () => app.quit());
process.once('SIGINT', () => app.quit());
app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault();
  if (stopping) return;
  if (win && !win.isDestroyed()) win.hide();
  updater?.dispose();
  stop().then(async () => {
    try {
      if (updater) {
        app.releaseSingleInstanceLock();
        await updater.finalizeOnQuit();
      }
    } catch (e) {
      console.error('Desktop updater finalize:', e.message);
    }
    allowQuit = true;
    app.quit();
  }).catch(e => {
    console.error('Desktop shutdown:', e.message);
    // Never silently pretend cleanup succeeded. The scoped systemd UI unit has
    // an ExecStopPost fallback; the per-task deadline/lease still bound failures.
    process.exitCode = 1; allowQuit = true; app.quit();
  });
});
