import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_UPDATE_PUBLIC_KEY,
  applyBundleUpdate,
  canonicalManifestBytes,
  compareVersions,
  createTarGz,
  downloadVerified,
  extractTarGzStrict,
  fetchManifest,
  isValidSemver,
  loadUpdateState,
  readInstalledMeta,
  resolveSafeArtifactUrl,
  rollbackBundleUpdate,
  saveUpdateState,
  selectUpdateArtifact,
  signManifest,
  verifyManifestSignature,
} from '../updater-core.mjs';
import updaterMod from '../updater.cjs';
import deviceContract from '../../account-devices/contract.cjs';

const { DesktopUpdater, checkStartupRollbackSync } = updaterMod;
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const labRoot = resolve(repoRoot, '..');

function makeKeyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('semver parsing & comparison handles release and prerelease versions', () => {
  assert.equal(isValidSemver('0.4.14'), true);
  assert.equal(isValidSemver('1.2.3-rc.1'), true);
  assert.equal(isValidSemver('v0.4.14'), false);
  assert.equal(isValidSemver('0.4'), false);
  assert.equal(compareVersions('0.4.15', '0.4.14'), 1);
  assert.equal(compareVersions('0.4.14', '0.4.14'), 0);
  assert.equal(compareVersions('0.4.14', '0.5.0'), -1);
  assert.equal(compareVersions('0.5.0-beta.1', '0.5.0'), -1);
  assert.equal(compareVersions('0.5.0-beta.2', '0.5.0-beta.10'), -1);
  assert.throws(() => compareVersions('bad', '0.4.14'), /INVALID_SEMVER/);
});

test('Ed25519 manifest signing verifies canonical payload and rejects tampering', () => {
  const { publicKey, privateKey } = makeKeyPair();
  const base = {
    schemaVersion: 1,
    channel: 'stable',
    version: '0.4.15',
    publishedAt: '2026-11-25T12:00:00Z',
    notes: '### 新增\n- 自动更新',
    targets: {
      'linux-x64': {
        bundle: {
          url: '/updates/anywhere-mesh-app-0.4.15-linux-x64.tar.gz',
          sha256: 'a'.repeat(64),
          size: 12345,
          runtimeAbi: 'e45.3.3-n24.21.0-et2.6.4-lin',
        },
      },
    },
  };
  const signed = signManifest(base, privateKey);
  assert.equal(verifyManifestSignature(signed, publicKey), true);

  // Reordered keys still produce identical canonical bytes and verify cleanly
  const reordered = {
    signature: signed.signature,
    targets: signed.targets,
    notes: signed.notes,
    publishedAt: signed.publishedAt,
    version: signed.version,
    channel: signed.channel,
    schemaVersion: signed.schemaVersion,
  };
  assert.deepEqual(canonicalManifestBytes(signed), canonicalManifestBytes(reordered));
  assert.equal(verifyManifestSignature(reordered, publicKey), true);

  // Tampering any field or using another key fails verification
  assert.equal(verifyManifestSignature({ ...signed, version: '0.4.16' }, publicKey), false);
  assert.equal(verifyManifestSignature({ ...signed, notes: 'tampered' }, publicKey), false);
  const other = makeKeyPair();
  assert.equal(verifyManifestSignature(signed, other.publicKey), false);
  assert.equal(verifyManifestSignature({ ...signed, signature: 'not-valid' }, publicKey), false);
});

test('selectUpdateArtifact chooses bundle on matching runtimeAbi, falls back to full, and enforces anti-loop', () => {
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    version: '0.4.15',
    notes: 'notes',
    targets: {
      'win32-x64': {
        bundle: {
          url: '/updates/app.tar.gz',
          sha256: 'a'.repeat(64),
          size: 300000,
          runtimeAbi: 'abi-v1',
        },
        full: {
          url: '/updates/Setup.exe',
          sha256: 'b'.repeat(64),
          size: 200000000,
          kind: 'nsis',
        },
      },
    },
  };

  // Up to date
  const same = selectUpdateArtifact(manifest, { currentVersion: '0.4.15', platformKey: 'win32-x64', runtimeAbi: 'abi-v1' });
  assert.equal(same.available, false);
  assert.equal(same.upToDate, true);

  // Matching ABI -> lightweight bundle
  const fast = selectUpdateArtifact(manifest, { currentVersion: '0.4.14', platformKey: 'win32-x64', runtimeAbi: 'abi-v1' });
  assert.equal(fast.available, true);
  assert.equal(fast.mode, 'bundle');
  assert.equal(fast.artifact.size, 300000);
  assert.equal(fast.blockedByFailure, false);

  // Changed ABI -> full installer fallback
  const full = selectUpdateArtifact(manifest, { currentVersion: '0.4.14', platformKey: 'win32-x64', runtimeAbi: 'abi-old' });
  assert.equal(full.available, true);
  assert.equal(full.mode, 'full');
  assert.equal(full.kind, 'nsis');

  // Repeated failures trigger anti-loop block
  const blocked = selectUpdateArtifact(manifest, {
    currentVersion: '0.4.14',
    platformKey: 'win32-x64',
    runtimeAbi: 'abi-v1',
    failedVersions: { '0.4.15': { count: 2, reason: 'NEW_VERSION_STARTUP_FAILED' } },
  });
  assert.equal(blocked.available, true);
  assert.equal(blocked.blockedByFailure, true);

  // Origin / scheme safety
  assert.equal(resolveSafeArtifactUrl('https://awc.xbxbe.com', '/updates/a.tar.gz').href, 'https://awc.xbxbe.com/updates/a.tar.gz');
  assert.throws(() => resolveSafeArtifactUrl('https://awc.xbxbe.com', 'https://evil.example/a.tar.gz'), /UNTRUSTED_UPDATE_ORIGIN/);
  assert.throws(() => resolveSafeArtifactUrl('http://awc.xbxbe.com', '/updates/a.tar.gz'), /INSECURE_UPDATE_URL/);
});

test('extractTarGzStrict extracts valid entries (including PAX long paths) and blocks traversal & symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-tar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const longPath = 'src/' + 'nested-directory/'.repeat(7) + 'module.mjs';
  const okTar = createTarGz([
    { name: 'package.json', content: '{"version":"0.4.15"}\n', mode: 0o644 },
    { name: longPath, content: 'export const ok = true;\n', mode: 0o755 },
  ]);
  const res = extractTarGzStrict(okTar, join(dir, 'ok'));
  assert.equal(res.fileCount, 2);
  assert.equal(readFileSync(join(dir, 'ok', longPath), 'utf8'), 'export const ok = true;\n');

  // Path traversal rejected
  const evilTraversal = createTarGz([{ name: '../escape.txt', content: 'pwned' }]);
  assert.throws(() => extractTarGzStrict(evilTraversal, join(dir, 'evil1')), /UNSAFE_ARCHIVE_PATH/);

  // Absolute path rejected
  const evilAbs = createTarGz([{ name: '/etc/passwd', content: 'pwned' }]);
  assert.throws(() => extractTarGzStrict(evilAbs, join(dir, 'evil2')), /UNSAFE_ARCHIVE_PATH/);

  // Backslash rejected
  const evilSlash = createTarGz([{ name: 'a\\..\\b.txt', content: 'pwned' }]);
  assert.throws(() => extractTarGzStrict(evilSlash, join(dir, 'evil3')), /UNSAFE_ARCHIVE_PATH/);

  // Symlink rejected
  const evilSymlink = createTarGz([{ name: 'link', content: '', type: '2' }]);
  assert.throws(() => extractTarGzStrict(evilSymlink, join(dir, 'evil4')), /UNSUPPORTED_ARCHIVE_ENTRY_TYPE/);
});

test('IPC contract strictly validates update routes and rejects URLs/paths/arbitrary fields', () => {
  for (const m of ['updateStatus', 'updateCheck', 'updateDownload', 'updateCancel', 'updateInstall', 'updateSettings']) {
    assert.doesNotThrow(() => deviceContract.validate(m, {}));
  }
  assert.doesNotThrow(() => deviceContract.validate('updateCheck', { manual: true }));
  assert.doesNotThrow(() => deviceContract.validate('updateInstall', { relaunch: false }));
  assert.doesNotThrow(() => deviceContract.validate('updateSettings', { autoCheck: true, autoDownload: false, installOnQuit: true }));
  assert.doesNotThrow(() => deviceContract.validate('updateDismiss', { version: '0.4.15' }));

  // Must reject any renderer-supplied URL, path, or invalid types
  assert.throws(() => deviceContract.validate('updateCheck', { url: 'https://evil.com' }), /INVALID_FIELDS/);
  assert.throws(() => deviceContract.validate('updateDownload', { path: '/tmp/x' }), /INVALID_FIELDS/);
  assert.throws(() => deviceContract.validate('updateInstall', { relaunch: 'yes' }), /INVALID_FIELDS/);
  assert.throws(() => deviceContract.validate('updateDismiss', { version: '../etc' }), /INVALID_FIELDS/);
});

test('end-to-end DesktopUpdater, apply-update.mjs, helper preservation, boot health and startup rollback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-upd-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { publicKey, privateKey } = makeKeyPair();
  const dataRoot = join(dir, 'data');
  const appDir = join(dir, 'resources', 'app');
  mkdirSync(join(appDir, 'src/desktop'), { recursive: true });
  mkdirSync(join(appDir, 'src/account-devices/windows'), { recursive: true });

  // Installed v0.4.14 with simulated Windows native helper to verify preservation
  const runtimeAbi = 'e45.3.3-n24.21.0-et2.6.4-test';
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'anywhere-mesh', version: '0.4.14', runtimeAbi, main: 'src/desktop/main.cjs' }));
  writeFileSync(join(appDir, 'src/desktop/main.cjs'), '// v0.4.14\n');
  writeFileSync(join(appDir, 'src/account-devices/windows/PeerHost.exe'), 'MZ-OLD-HELPER');

  // Build signed v0.4.15 bundle
  const bundleGz = createTarGz([
    { name: 'package.json', content: JSON.stringify({ name: 'anywhere-mesh', version: '0.4.15', runtimeAbi, main: 'src/desktop/main.cjs' }) },
    { name: 'src/desktop/main.cjs', content: '// v0.4.15 upgraded!\n' },
  ]);
  const bundleHash = sha256(bundleGz);
  const platformKey = `${process.platform}-${process.arch}`;
  const signedManifest = signManifest({
    schemaVersion: 1,
    channel: 'stable',
    version: '0.4.15',
    publishedAt: '2026-11-25T12:00:00Z',
    notes: '### 新功能\n- 极速热更新',
    targets: {
      [platformKey]: {
        bundle: {
          url: '/updates/anywhere-mesh-app-0.4.15.tar.gz',
          sha256: bundleHash,
          size: bundleGz.length,
          runtimeAbi,
        },
      },
    },
  }, privateKey);

  // Spin up local HTTP update server
  const server = http.createServer((req, res) => {
    if (req.url === '/updates/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(signedManifest));
      return;
    }
    if (req.url === '/updates/anywhere-mesh-app-0.4.15.tar.gz') {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(bundleGz.length) });
      res.end(bundleGz);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Test direct fetchManifest + downloadVerified + checksum mismatch rejection
  const fetched = await fetchManifest(baseUrl, { publicKeyPem: publicKey, allowHttpLocalhost: true });
  assert.equal(fetched.version, '0.4.15');
  await assert.rejects(
    downloadVerified(`${baseUrl}/updates/anywhere-mesh-app-0.4.15.tar.gz`, join(dir, 'bad.tar.gz'), {
      expectedSha256: '0'.repeat(64),
      expectedSize: bundleGz.length,
      allowHttpLocalhost: true,
    }),
    /UPDATE_CHECKSUM_MISMATCH/,
  );

  // Run DesktopUpdater check -> auto-download -> ready
  const states = [];
  let quitRequested = false;
  const updater = new DesktopUpdater({
    dataRoot,
    appDir,
    nodeBin: process.execPath,
    relaunchExe: process.execPath,
    canInstall: true,
    updateBaseUrl: baseUrl,
    publicKeyPem: publicKey,
    allowHttpLocalhost: true,
    onStateChange: s => states.push(s.status),
    requestQuit: () => { quitRequested = true; },
  });
  await updater.init();
  await updater.check({ manual: true });
  // Wait for background auto-download to reach 'ready'
  for (let i = 0; i < 40 && updater.status !== 'ready'; i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(updater.status, 'ready');
  assert.equal(updater.snapshot().update.version, '0.4.15');
  assert.equal(updater.snapshot().update.mode, 'bundle');

  // Apply bundle directly via applyBundleUpdate preserving PeerHost.exe
  const pendingPath = updater.persisted.pendingInstall.filePath;
  await applyBundleUpdate({
    archivePath: pendingPath,
    expectedSha256: bundleHash,
    targetVersion: '0.4.15',
    appDir,
    backupDir: appDir + '.prev',
    preserveRelPaths: ['src/account-devices/windows/PeerHost.exe'],
  });
  assert.equal(readInstalledMeta(appDir).version, '0.4.15');
  assert.equal(readFileSync(join(appDir, 'src/desktop/main.cjs'), 'utf8'), '// v0.4.15 upgraded!\n');
  assert.equal(readFileSync(join(appDir, 'src/account-devices/windows/PeerHost.exe'), 'utf8'), 'MZ-OLD-HELPER');
  assert.equal(existsSync(appDir + '.prev'), true);

  // Test startup rollback guard if new version crashes on first boot
  const stateFile = join(dataRoot, 'updates', 'state.json');
  const st = loadUpdateState(stateFile);
  st.appliedAttempt = {
    fromVersion: '0.4.14',
    toVersion: '0.4.15',
    mode: 'bundle',
    appDir,
    backupDir: appDir + '.prev',
    appliedAt: Date.now(),
    bootCount: 0,
  };
  saveUpdateState(stateFile, st);

  // Boot 1: increments bootCount to 1, does not roll back yet
  const boot1 = checkStartupRollbackSync({ dataRoot, appDir, currentVersion: '0.4.15' });
  assert.equal(boot1.rolledBack, false);
  assert.equal(loadUpdateState(stateFile).appliedAttempt.bootCount, 1);

  // Simulate crash before markBootHealthy -> Boot 2 triggers automatic rollback to 0.4.14!
  const boot2 = checkStartupRollbackSync({ dataRoot, appDir, currentVersion: '0.4.15' });
  assert.equal(boot2.rolledBack, true);
  assert.equal(boot2.failedVersion, '0.4.15');
  assert.equal(readInstalledMeta(appDir).version, '0.4.14');
  const afterRollback = loadUpdateState(stateFile);
  assert.equal(afterRollback.failedVersions['0.4.15'].count >= 2, true);
  assert.equal(afterRollback.lastRollback.version, '0.4.15');

  // Verify healthy boot flow cleans backup and exposes justUpdatedFrom
  await applyBundleUpdate({
    archivePath: pendingPath,
    expectedSha256: bundleHash,
    targetVersion: '0.4.15',
    appDir,
    backupDir: appDir + '.prev',
    preserveRelPaths: ['src/account-devices/windows/PeerHost.exe'],
  });
  const stHealthy = loadUpdateState(stateFile);
  stHealthy.appliedAttempt = {
    fromVersion: '0.4.14',
    toVersion: '0.4.15',
    mode: 'bundle',
    appDir,
    backupDir: appDir + '.prev',
    appliedAt: Date.now(),
    bootCount: 1,
  };
  saveUpdateState(stateFile, stHealthy);

  const updater2 = new DesktopUpdater({
    dataRoot,
    appDir,
    nodeBin: process.execPath,
    relaunchExe: process.execPath,
    canInstall: true,
    updateBaseUrl: baseUrl,
    publicKeyPem: publicKey,
    allowHttpLocalhost: true,
  });
  await updater2.init();
  updater2.markBootHealthy();
  assert.equal(existsSync(appDir + '.prev'), false);
  assert.equal(updater2.snapshot().justUpdatedFrom, '0.4.14');
  assert.equal(loadUpdateState(stateFile).appliedAttempt, null);

  // Test standalone apply-update.mjs subprocess with exited PID
  const subDir = mkdtempSync(join(tmpdir(), 'anywhere-apply-sub-'));
  t.after(() => rmSync(subDir, { recursive: true, force: true }));
  const subApp = join(subDir, 'app');
  mkdirSync(join(subApp, 'src/desktop'), { recursive: true });
  writeFileSync(join(subApp, 'package.json'), JSON.stringify({ name: 'anywhere-mesh', version: '0.4.14', runtimeAbi, main: 'src/desktop/main.cjs' }));
  writeFileSync(join(subApp, 'src/desktop/main.cjs'), '// old\n');
  const subState = join(subDir, 'updates', 'state.json');
  const subJob = join(subDir, 'job.json');
  writeFileSync(subJob, JSON.stringify({
    mode: 'bundle',
    kind: 'app-bundle',
    fromVersion: '0.4.14',
    targetVersion: '0.4.15',
    archivePath: pendingPath,
    sha256: bundleHash,
    appDir: subApp,
    backupDir: subApp + '.prev',
    stateFile: subState,
    relaunch: false,
    waitPids: [],
  }));
  const applyScript = resolve(__dirname, '../apply-update.mjs');
  execFileSync(process.execPath, [applyScript, subJob], { stdio: 'pipe', timeout: 15000 });
  assert.equal(readInstalledMeta(subApp).version, '0.4.15');
  assert.equal(existsSync(subJob), false);
  assert.equal(loadUpdateState(subState).appliedAttempt.toVersion, '0.4.15');

  // Verify rollback helper standalone
  assert.equal(rollbackBundleUpdate({ appDir: subApp, backupDir: subApp + '.prev' }), true);
  assert.equal(readInstalledMeta(subApp).version, '0.4.14');

  updater.dispose();
  updater2.dispose();
  assert.equal(quitRequested, false);
});

test('cross-language publish-update.py generates signed manifest verifiable by built-in public key and strict tar extractor', t => {
  const wsArchive = join(labRoot, 'images/ws-8.22.0.tgz');
  const dcArchive = join(labRoot, 'images/desktop-commander-0.3.3.tgz');
  const signingKey = join(labRoot, 'secrets/update-signing.pem');
  if (!existsSync(wsArchive) || !existsSync(dcArchive) || !existsSync(signingKey)) {
    t.skip('Pinned lab archives or signing key not present');
    return;
  }

  const outDir = mkdtempSync(join(tmpdir(), 'anywhere-pub-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const pubScript = join(repoRoot, 'src/account-devices/wan/publish-update.py');
  execFileSync('python3', [
    pubScript,
    '--ws', wsArchive,
    '--dc', dcArchive,
    '--signing-key', signingKey,
    '--output-dir', outDir,
    '--notes', '### 测试发版\n- 自动更新跨语言验签',
  ], { stdio: 'pipe', timeout: 30000 });

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(verifyManifestSignature(manifest, DEFAULT_UPDATE_PUBLIC_KEY), true);

  for (const key of ['win32-x64', 'linux-x64']) {
    const bundle = manifest.targets[key].bundle;
    const filename = bundle.url.split('/').pop();
    const archiveBytes = readFileSync(join(outDir, filename));
    assert.equal(archiveBytes.length, bundle.size);
    assert.equal(sha256(archiveBytes), bundle.sha256);

    const extractDest = join(outDir, 'extracted-' + key);
    const extracted = extractTarGzStrict(archiveBytes, extractDest);
    assert.ok(extracted.fileCount > 25);
    const meta = readInstalledMeta(extractDest);
    assert.equal(meta.version, manifest.version);
    assert.equal(meta.runtimeAbi, bundle.runtimeAbi);
    assert.equal(existsSync(join(extractDest, 'src/desktop/main.cjs')), true);
    assert.equal(existsSync(join(extractDest, 'src/desktop/updater.cjs')), true);
    assert.equal(existsSync(join(extractDest, 'src/desktop/updater-core.mjs')), true);
    assert.equal(existsSync(join(extractDest, 'src/desktop/apply-update.mjs')), true);
  }
});

test('linux-agent.mjs --check-update verifies signed manifest and prints update info', async t => {
  const { publicKey, privateKey } = makeKeyPair();
  const platformKey = `${process.platform}-${process.arch}`;
  const signedManifest = signManifest({
    schemaVersion: 1,
    channel: 'stable',
    version: '9.9.9',
    publishedAt: '2026-11-25T12:00:00Z',
    notes: '- CLI 自动更新测试条目',
    targets: {
      [platformKey]: {
        full: {
          url: '/updates/AnywhereMesh-9.9.9-linux-x64.tar.gz',
          sha256: 'c'.repeat(64),
          size: 4096,
          kind: 'linux-tar',
        },
      },
    },
  }, privateKey);

  const server = http.createServer((req, res) => {
    if (req.url === '/updates/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(signedManifest));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const agentPath = join(repoRoot, 'src/account-devices/linux-agent.mjs');
  const out = await new Promise((resolveOut, rejectOut) => {
    const child = spawn(process.execPath, [agentPath, '--check-update', '--update-url', baseUrl], {
      env: {
        ...process.env,
        ANYWHERE_MESH_UPDATE_PUBKEY: publicKey,
        ANYWHERE_MESH_UPDATE_ALLOW_HTTP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.once('error', rejectOut);
    child.once('close', code => {
      if (code !== 0) rejectOut(Error(`exit ${code}: ${stderr}`));
      else resolveOut(stdout);
    });
  });
  assert.match(out, /Update available:.*-> v9\.9\.9/);
  assert.match(out, /CLI 自动更新测试条目/);
});
