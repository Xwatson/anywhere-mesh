import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WINDOWS_PRESERVED_HELPERS,
  applyBundleUpdate,
  cleanupOldCacheFiles,
  computeFileSha256,
  loadUpdateState,
  saveUpdateState,
} from './updater-core.mjs';

function makeLogger(logFile) {
  return (level, message, extra = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }) + '\n';
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      let existing = '';
      if (existsSync(logFile)) {
        const st = statSync(logFile);
        if (st.size > 64 * 1024) {
          existing = readFileSync(logFile, 'utf8').slice(-32 * 1024);
        } else {
          existing = readFileSync(logFile, 'utf8');
        }
      }
      writeFileSync(logFile, existing + line, { mode: 0o600 });
    } catch {}
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function waitForPidsExit(pids, timeoutMs = 45000) {
  const unique = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0))];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (unique.every(pid => !isPidAlive(pid))) return true;
    await delay(150);
  }
  return unique.every(pid => !isPidAlive(pid));
}

function updateWindowsDisplayVersion(version) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('reg.exe', [
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnywhereMesh',
      '/v', 'DisplayVersion',
      '/t', 'REG_SZ',
      '/d', version,
      '/f',
    ], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function spawnDetached(exe, args = [], opts = {}) {
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: Boolean(opts.windowsHide),
    cwd: opts.cwd,
    env: opts.env,
  });
  child.unref();
}

function recordFailure(stateFile, targetVersion, reason) {
  const st = loadUpdateState(stateFile);
  const prev = st.failedVersions[targetVersion] ?? { count: 0 };
  st.failedVersions[targetVersion] = {
    count: prev.count + 1,
    reason: String(reason || 'UPDATE_APPLY_FAILED').slice(0, 200),
    at: Date.now(),
  };
  st.pendingInstall = null;
  st.appliedAttempt = null;
  saveUpdateState(stateFile, st);
}

async function run() {
  const jobPath = process.argv[2];
  if (!jobPath || !existsSync(jobPath)) process.exit(1);
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const log = makeLogger(job.logFile || join(dirname(job.stateFile), 'update.log'));

  log('info', 'apply_start', {
    mode: job.mode,
    kind: job.kind,
    fromVersion: job.fromVersion,
    targetVersion: job.targetVersion,
    relaunch: Boolean(job.relaunch),
    waitPids: job.waitPids,
  });

  const exited = await waitForPidsExit(job.waitPids ?? [], 45000);
  if (!exited) {
    log('error', 'parent_exit_timeout', { waitPids: job.waitPids });
    recordFailure(job.stateFile, job.targetVersion, 'PARENT_EXIT_TIMEOUT');
    rmSync(jobPath, { force: true });
    process.exit(1);
  }
  if (process.platform === 'win32') await delay(350);

  try {
    const actualSha = await computeFileSha256(job.archivePath);
    if (actualSha !== job.sha256) throw Error('UPDATE_CHECKSUM_MISMATCH');

    if (job.mode === 'bundle') {
      const backupDir = job.backupDir || (job.appDir + '.prev');
      await applyBundleUpdate({
        archivePath: job.archivePath,
        expectedSha256: job.sha256,
        targetVersion: job.targetVersion,
        appDir: job.appDir,
        backupDir,
        preserveRelPaths: process.platform === 'win32' ? WINDOWS_PRESERVED_HELPERS : [],
      });
      if (process.platform === 'win32') updateWindowsDisplayVersion(job.targetVersion);

      const st = loadUpdateState(job.stateFile);
      st.pendingInstall = null;
      st.appliedAttempt = {
        fromVersion: job.fromVersion,
        toVersion: job.targetVersion,
        mode: 'bundle',
        appDir: job.appDir,
        backupDir,
        appliedAt: Date.now(),
        bootCount: 0,
      };
      saveUpdateState(job.stateFile, st);
      if (job.cacheDir) cleanupOldCacheFiles(job.cacheDir, []);
      log('info', 'bundle_applied', { targetVersion: job.targetVersion });

      if (job.relaunch && job.relaunchExe && existsSync(job.relaunchExe)) {
        spawnDetached(job.relaunchExe, job.relaunchArgs ?? [], {
          cwd: dirname(job.relaunchExe),
          windowsHide: false,
        });
        log('info', 'relaunched', { exe: job.relaunchExe });
      }
    } else if (job.mode === 'full' && job.kind === 'nsis') {
      if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
      const st = loadUpdateState(job.stateFile);
      st.pendingInstall = null;
      st.appliedAttempt = {
        fromVersion: job.fromVersion,
        toVersion: job.targetVersion,
        mode: 'full',
        appliedAt: Date.now(),
        bootCount: 0,
      };
      saveUpdateState(job.stateFile, st);

      const nsisArgs = ['/S'];
      if (job.relaunch) nsisArgs.push('/RELAUNCH');
      spawnDetached(job.archivePath, nsisArgs, {
        cwd: dirname(job.archivePath),
        windowsHide: true,
      });
      log('info', 'nsis_launched', { archivePath: job.archivePath, args: nsisArgs });
    } else if (job.mode === 'full' && job.kind === 'linux-tar') {
      if (process.platform !== 'linux') throw Error('LINUX_REQUIRED');
      const extractBase = join(dirname(job.stateFile), 'staging');
      mkdirSync(extractBase, { recursive: true, mode: 0o700 });
      const extractDir = mkdtempSync(join(extractBase, 'linux-full-'));
      try {
        execFileSync('tar', ['-xzf', job.archivePath, '-C', extractDir], { stdio: 'ignore', timeout: 120000 });
        const entries = readdirSync(extractDir);
        const topDir = entries.length === 1 ? join(extractDir, entries[0]) : extractDir;
        const installSh = join(topDir, 'install.sh');
        if (!existsSync(installSh)) throw Error('MISSING_LINUX_INSTALL_SH');
        const installEnv = { ...process.env };
        if (job.installDir) installEnv.ANYWHERE_MESH_INSTALL_DIR = job.installDir;
        execFileSync('bash', [installSh], { env: installEnv, stdio: 'ignore', timeout: 120000 });
      } finally {
        rmSync(extractDir, { recursive: true, force: true });
      }

      const st = loadUpdateState(job.stateFile);
      st.pendingInstall = null;
      st.appliedAttempt = {
        fromVersion: job.fromVersion,
        toVersion: job.targetVersion,
        mode: 'full',
        appliedAt: Date.now(),
        bootCount: 0,
      };
      saveUpdateState(job.stateFile, st);
      if (job.cacheDir) cleanupOldCacheFiles(job.cacheDir, []);
      log('info', 'linux_full_applied', { targetVersion: job.targetVersion });

      const exe = job.relaunchExe || (job.installDir ? join(job.installDir, 'bin/anywhere-mesh') : null);
      if (job.relaunch && exe && existsSync(exe)) {
        spawnDetached(exe, job.relaunchArgs ?? [], { cwd: dirname(exe) });
        log('info', 'relaunched', { exe });
      }
    } else {
      throw Error('UNSUPPORTED_UPDATE_MODE');
    }
  } catch (err) {
    log('error', 'apply_failed', { error: err?.message ?? String(err) });
    recordFailure(job.stateFile, job.targetVersion, err?.message ?? 'UPDATE_APPLY_FAILED');
    if (job.relaunch && job.relaunchExe && existsSync(job.relaunchExe)) {
      try { spawnDetached(job.relaunchExe, job.relaunchArgs ?? [], { cwd: dirname(job.relaunchExe) }); } catch {}
    }
    process.exitCode = 1;
  } finally {
    rmSync(jobPath, { force: true });
  }
}

run().catch(err => {
  console.error('apply-update fatal:', err?.message ?? err);
  process.exit(1);
});
