'use strict';
const { execFileSync, spawn } = require('node:child_process');
const { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const CHECK_INITIAL_DELAY_MS = 12 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CHECK_FOCUS_MIN_GAP_MS = 30 * 60 * 1000;

let corePromise = null;
function loadCore() {
  if (!corePromise) {
    corePromise = import(pathToFileURL(resolve(__dirname, 'updater-core.mjs')).href);
  }
  return corePromise;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function moveDirSync(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function syncMacBundleMetadataAndSign(bundleDir, version) {
  if (process.platform !== 'darwin' || !bundleDir || !bundleDir.endsWith('.app')) return;
  const plist = join(bundleDir, 'Contents', 'Info.plist');
  if (existsSync(plist) && version) {
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, plist], { stdio: 'ignore', timeout: 10000 });
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', version, plist], { stdio: 'ignore', timeout: 10000 });
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundleDir], { stdio: 'ignore', timeout: 60000 });
}

function checkStartupRollbackSync({ dataRoot, appDir, installDir = null, currentVersion }) {
  if (!dataRoot || !appDir) return { rolledBack: false };
  const stateFile = join(dataRoot, 'updates', 'state.json');
  const st = readJsonSafe(stateFile);
  if (!st?.appliedAttempt || st.appliedAttempt.mode !== 'bundle') return { rolledBack: false };

  const attempt = st.appliedAttempt;
  const backupDir = attempt.backupDir || (appDir + '.prev');

  if (attempt.bootCount >= 1 && attempt.toVersion === currentVersion && existsSync(backupDir)) {
    const brokenDir = process.platform === 'darwin'
      ? join(dataRoot, 'updates', `app.broken.${Date.now()}`)
      : `${appDir}.broken.${Date.now()}`;
    try {
      if (existsSync(appDir)) moveDirSync(appDir, brokenDir);
      moveDirSync(backupDir, appDir);
      rmSync(brokenDir, { recursive: true, force: true });
      if (process.platform === 'darwin') {
        try { syncMacBundleMetadataAndSign(attempt.installDir || installDir, attempt.fromVersion); } catch {}
      }

      const failed = st.failedVersions && typeof st.failedVersions === 'object' ? { ...st.failedVersions } : {};
      const prev = failed[attempt.toVersion] ?? { count: 0 };
      failed[attempt.toVersion] = {
        count: Math.max(2, (prev.count || 0) + 1),
        reason: 'NEW_VERSION_STARTUP_FAILED',
        at: Date.now(),
      };
      st.failedVersions = failed;
      st.appliedAttempt = null;
      st.pendingInstall = null;
      st.lastRollback = { version: attempt.toVersion, at: Date.now(), seen: false };
      writeJsonAtomic(stateFile, st);
      return { rolledBack: true, failedVersion: attempt.toVersion };
    } catch {
      if (!existsSync(appDir) && existsSync(brokenDir)) {
        try { moveDirSync(brokenDir, appDir); } catch {}
      }
      return { rolledBack: false };
    }
  }

  if (attempt.toVersion === currentVersion && (attempt.bootCount ?? 0) === 0) {
    st.appliedAttempt = { ...attempt, bootCount: 1 };
    try { writeJsonAtomic(stateFile, st); } catch {}
  }
  return { rolledBack: false };
}

class DesktopUpdater {
  constructor(opts) {
    this.dataRoot = opts.dataRoot;
    this.appDir = opts.appDir;
    this.installDir = opts.installDir || null;
    this.nodeBin = opts.nodeBin;
    this.relaunchExe = opts.relaunchExe;
    this.relaunchArgs = opts.relaunchArgs || [];
    this.canInstall = Boolean(opts.canInstall);
    this.platform = opts.platform || process.platform;
    this.arch = opts.arch || process.arch;
    const savedServer = readJsonSafe(join(this.dataRoot, 'server.json'))?.serverUrl;
    const pkg = readJsonSafe(join(this.appDir, 'package.json')) || {};
    const rawBase = opts.updateBaseUrl || process.env.ANYWHERE_MESH_UPDATE_URL || savedServer || process.env.ANYWHERE_MESH_URL || pkg.defaultServerUrl || '';
    this.updateBaseUrl = typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim().replace(/\/+$/, '') : null;
    this.publicKeyPem = opts.publicKeyPem || process.env.ANYWHERE_MESH_UPDATE_PUBKEY || null;
    this.allowHttpLocalhost = Boolean(opts.allowHttpLocalhost || process.env.ANYWHERE_MESH_UPDATE_ALLOW_HTTP === '1');
    this.getExtraPids = opts.getExtraPids || (() => []);
    this.onStateChange = opts.onStateChange || (() => {});
    this.requestQuit = opts.requestQuit || (() => {});

    this.updatesDir = join(this.dataRoot, 'updates');
    this.stateFile = join(this.updatesDir, 'state.json');
    this.cacheDir = join(this.updatesDir, 'cache');
    this.runnerDir = join(this.updatesDir, 'runner');
    this.logFile = join(this.updatesDir, 'update.log');

    this.currentVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '0.0.0';
    this.runtimeAbi = typeof pkg.runtimeAbi === 'string' && pkg.runtimeAbi.trim() ? pkg.runtimeAbi.trim() : null;

    this.persisted = null;
    this.status = 'idle';
    this.selected = null;
    this.progress = null;
    this.error = null;
    this.justUpdatedFrom = null;
    this.rolledBackVersion = opts.rolledBackVersion || null;
    this.checkInFlight = null;
    this.downloadInFlight = null;
    this.downloadAbort = null;
    this.quitJob = null;
    this.initialTimer = null;
    this.intervalTimer = null;
    this.destroyed = false;
  }

  async init() {
    const core = await loadCore();
    this.core = core;
    if (!this.publicKeyPem) this.publicKeyPem = core.DEFAULT_UPDATE_PUBLIC_KEY;
    this.persisted = core.loadUpdateState(this.stateFile);

    const pending = this.persisted.pendingInstall;
    if (pending && pending.version && core.isValidSemver(pending.version) && core.isValidSemver(this.currentVersion)) {
      if (core.compareVersions(pending.version, this.currentVersion) > 0 && pending.filePath && existsSync(pending.filePath)) {
        try {
          const sha = await core.computeFileSha256(pending.filePath);
          if (sha === pending.sha256) {
            this.selected = {
              version: pending.version,
              publishedAt: pending.publishedAt ?? null,
              notes: pending.notes ?? '',
              channel: pending.channel ?? 'stable',
              mode: pending.mode,
              kind: pending.kind,
              artifact: {
                url: pending.url || '',
                sha256: pending.sha256,
                size: pending.size || 0,
              },
              blockedByFailure: false,
            };
            this.status = 'ready';
            this.progress = { downloadedBytes: pending.size || 0, totalBytes: pending.size || 0, percent: 100, speedBps: 0 };
          } else {
            this.persisted.pendingInstall = null;
            this.savePersisted();
          }
        } catch {
          this.persisted.pendingInstall = null;
          this.savePersisted();
        }
      } else {
        this.persisted.pendingInstall = null;
        this.savePersisted();
      }
    }

    if (this.persisted.lastUpdatedTo?.version === this.currentVersion && !this.persisted.lastUpdatedTo.seen) {
      this.justUpdatedFrom = this.persisted.lastUpdatedTo.fromVersion || null;
      this.persisted.lastUpdatedTo = { ...this.persisted.lastUpdatedTo, seen: true };
      this.savePersisted();
    }
    if (this.persisted.lastRollback?.version && !this.persisted.lastRollback.seen) {
      this.rolledBackVersion = this.persisted.lastRollback.version;
      this.persisted.lastRollback = { ...this.persisted.lastRollback, seen: true };
      this.savePersisted();
    }

    this.scheduleTimers();
    this.emit();
    return this.snapshot();
  }

  scheduleTimers() {
    clearTimeout(this.initialTimer);
    clearInterval(this.intervalTimer);
    if (this.destroyed || !this.persisted?.autoCheck) return;
    this.initialTimer = setTimeout(() => {
      if (!this.destroyed && this.persisted?.autoCheck) {
        void this.check({ manual: false }).catch(() => {});
      }
    }, CHECK_INITIAL_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      if (!this.destroyed && this.persisted?.autoCheck) {
        void this.check({ manual: false }).catch(() => {});
      }
    }, CHECK_INTERVAL_MS);
  }

  onWindowFocus() {
    if (this.destroyed || !this.persisted?.autoCheck) return;
    if (this.status === 'downloading' || this.status === 'ready' || this.status === 'installing') return;
    const last = this.persisted.lastCheckedAt ?? 0;
    if (Date.now() - last >= CHECK_FOCUS_MIN_GAP_MS) {
      void this.check({ manual: false }).catch(() => {});
    }
  }

  markBootHealthy() {
    if (!this.persisted || !this.core) return;
    const attempt = this.persisted.appliedAttempt;
    if (!attempt) return;

    if (attempt.toVersion === this.currentVersion) {
      if (attempt.backupDir && existsSync(attempt.backupDir)) {
        try { rmSync(attempt.backupDir, { recursive: true, force: true }); } catch {}
      }
      const runnerNode = join(this.runnerDir, 'node');
      if (existsSync(runnerNode)) {
        try { rmSync(runnerNode, { force: true }); } catch {}
      }
      this.justUpdatedFrom = attempt.fromVersion || null;
      this.persisted.lastUpdatedTo = {
        version: this.currentVersion,
        fromVersion: attempt.fromVersion || null,
        at: Date.now(),
        seen: true,
      };
      delete this.persisted.failedVersions[this.currentVersion];
      this.persisted.appliedAttempt = null;
      this.savePersisted();
      this.emit();
    } else {
      const prev = this.persisted.failedVersions[attempt.toVersion] ?? { count: 0 };
      this.persisted.failedVersions[attempt.toVersion] = {
        count: prev.count + 1,
        reason: 'VERSION_UNCHANGED_AFTER_INSTALL',
        at: Date.now(),
      };
      this.persisted.appliedAttempt = null;
      this.savePersisted();
      this.emit();
    }
  }

  savePersisted() {
    if (!this.core || !this.persisted) return;
    try { this.core.saveUpdateState(this.stateFile, this.persisted); } catch {}
  }

  snapshot() {
    const sel = this.selected;
    const dismissed = Boolean(sel && this.persisted?.dismissedVersion === sel.version);
    const failedInfo = sel ? this.persisted?.failedVersions?.[sel.version] ?? null : null;
    return {
      supported: true,
      canInstall: this.canInstall,
      platform: `${this.platform}-${this.arch}`,
      currentVersion: this.currentVersion,
      runtimeAbi: this.runtimeAbi,
      status: this.status,
      channel: this.persisted?.channel ?? 'stable',
      autoCheck: this.persisted?.autoCheck ?? true,
      autoDownload: this.persisted?.autoDownload ?? true,
      installOnQuit: this.persisted?.installOnQuit ?? true,
      lastCheckedAt: this.persisted?.lastCheckedAt ?? null,
      justUpdatedFrom: this.justUpdatedFrom,
      rolledBackVersion: this.rolledBackVersion,
      dismissed,
      error: this.error,
      progress: this.progress,
      update: sel ? {
        version: sel.version,
        publishedAt: sel.publishedAt,
        notes: sel.notes,
        mode: sel.mode,
        kind: sel.kind,
        size: sel.artifact?.size ?? 0,
        blockedByFailure: Boolean(sel.blockedByFailure),
        lastFailure: failedInfo,
      } : null,
    };
  }

  emit() {
    try { this.onStateChange(this.snapshot()); } catch {}
  }

  setBaseUrl(url) {
    if (process.env.ANYWHERE_MESH_UPDATE_URL) return;
    if (typeof url !== 'string' || !url.trim()) return;
    const next = url.trim().replace(/\/+$/, '');
    if (next === this.updateBaseUrl) return;
    this.updateBaseUrl = next;
    this.emit();
    if (!this.destroyed && this.persisted?.autoCheck && !this.checkInFlight && !this.downloadInFlight && this.status !== 'ready') {
      void this.check({ manual: false }).catch(() => {});
    }
  }

  async check({ manual = false } = {}) {
    if (!this.core) await this.init();
    if (!this.updateBaseUrl) {
      if (manual) {
        this.status = 'error';
        this.error = 'UPDATE_SERVER_UNCONFIGURED';
        this.emit();
      }
      return this.snapshot();
    }
    if (this.downloadInFlight) return this.snapshot();
    if (this.checkInFlight) return this.checkInFlight;

    this.checkInFlight = (async () => {
      const prevStatus = this.status;
      if (manual || (prevStatus !== 'ready' && prevStatus !== 'installing')) {
        this.status = 'checking';
        this.error = null;
        this.emit();
      }
      try {
        const manifest = await this.core.fetchManifest(this.updateBaseUrl, {
          publicKeyPem: this.publicKeyPem,
          allowHttpLocalhost: this.allowHttpLocalhost,
        });
        this.persisted.lastCheckedAt = Date.now();
        this.savePersisted();

        const decision = this.core.selectUpdateArtifact(manifest, {
          currentVersion: this.currentVersion,
          platformKey: this.core.platformKeyFor(this.platform, this.arch),
          runtimeAbi: this.runtimeAbi,
          failedVersions: this.persisted.failedVersions,
          ignoreFailures: false,
        });

        if (!decision.available) {
          this.selected = null;
          this.progress = null;
          this.error = decision.incompatible ? decision.reason : null;
          this.status = decision.incompatible && manual ? 'error' : 'up-to-date';
          this.emit();
          return this.snapshot();
        }

        const pending = this.persisted.pendingInstall;
        if (pending && pending.version === decision.version && pending.sha256 === decision.artifact.sha256 && existsSync(pending.filePath)) {
          this.selected = decision;
          this.status = 'ready';
          this.progress = { downloadedBytes: decision.artifact.size, totalBytes: decision.artifact.size, percent: 100, speedBps: 0 };
          this.error = null;
          this.emit();
          return this.snapshot();
        }

        this.selected = decision;
        this.progress = null;
        this.error = null;
        this.status = 'available';
        if (manual && this.persisted.dismissedVersion === decision.version) {
          this.persisted.dismissedVersion = null;
          this.savePersisted();
        }
        this.emit();

        if (this.canInstall && this.persisted.autoDownload && !decision.blockedByFailure) {
          void this.download().catch(() => {});
        }
        return this.snapshot();
      } catch (err) {
        const code = err?.message || 'UPDATE_CHECK_FAILED';
        if (prevStatus === 'ready' && !manual) {
          this.status = 'ready';
        } else if (manual) {
          this.status = 'error';
          this.error = code;
        } else {
          this.status = prevStatus === 'ready' ? 'ready' : 'idle';
          this.error = code;
        }
        this.emit();
        return this.snapshot();
      }
    })().finally(() => { this.checkInFlight = null; });

    return this.checkInFlight;
  }

  async download() {
    if (!this.core) await this.init();
    if (!this.canInstall) throw Error('UPDATE_INSTALL_UNSUPPORTED');
    if (this.downloadInFlight) return this.downloadInFlight;
    if (!this.selected?.artifact) {
      await this.check({ manual: true });
      if (!this.selected?.artifact) return this.snapshot();
    }
    const sel = this.selected;
    if (sel.blockedByFailure) {
      delete this.persisted.failedVersions[sel.version];
      sel.blockedByFailure = false;
      this.savePersisted();
    }

    const abort = new AbortController();
    this.downloadAbort = abort;
    this.status = 'downloading';
    this.error = null;
    this.progress = { downloadedBytes: 0, totalBytes: sel.artifact.size, percent: 0, speedBps: 0 };
    this.emit();

    this.downloadInFlight = (async () => {
      try {
        const url = this.core.resolveSafeArtifactUrl(this.updateBaseUrl, sel.artifact.url, {
          allowHttpLocalhost: this.allowHttpLocalhost,
        });
        const safeName = basename(url.pathname).replace(/[^A-Za-z0-9._-]/g, '_');
        if (!safeName || safeName === '.' || safeName === '..') throw Error('INVALID_UPDATE_URL');
        const destFile = join(this.cacheDir, safeName);

        const maxBytes = sel.mode === 'bundle' ? this.core.MAX_BUNDLE_ARCHIVE_BYTES : this.core.MAX_FULL_ARTIFACT_BYTES;
        const result = await this.core.downloadVerified(url, destFile, {
          expectedSha256: sel.artifact.sha256,
          expectedSize: sel.artifact.size,
          maxBytes,
          signal: abort.signal,
          allowHttpLocalhost: this.allowHttpLocalhost,
          onProgress: p => {
            this.progress = p;
            this.emit();
          },
        });

        this.persisted.pendingInstall = {
          version: sel.version,
          publishedAt: sel.publishedAt,
          notes: sel.notes,
          channel: sel.channel,
          mode: sel.mode,
          kind: sel.kind,
          url: sel.artifact.url,
          filePath: result.path,
          sha256: result.sha256,
          size: result.size,
          downloadedAt: Date.now(),
        };
        this.savePersisted();
        this.core.cleanupOldCacheFiles(this.cacheDir, [result.path]);

        this.status = 'ready';
        this.progress = { downloadedBytes: result.size, totalBytes: result.size, percent: 100, speedBps: 0 };
        this.error = null;
        this.emit();
        return this.snapshot();
      } catch (err) {
        const code = err?.message || 'UPDATE_DOWNLOAD_FAILED';
        if (code === 'UPDATE_CANCELLED') {
          this.status = this.selected ? 'available' : 'idle';
          this.progress = null;
          this.error = null;
        } else {
          this.status = 'error';
          this.error = code;
        }
        this.emit();
        return this.snapshot();
      }
    })().finally(() => {
      this.downloadInFlight = null;
      this.downloadAbort = null;
    });

    return this.downloadInFlight;
  }

  cancelDownload() {
    if (this.downloadAbort) {
      this.downloadAbort.abort();
    }
    return this.snapshot();
  }

  async updateSettings(patch = {}) {
    if (!this.core) await this.init();
    if (typeof patch.autoCheck === 'boolean') this.persisted.autoCheck = patch.autoCheck;
    if (typeof patch.autoDownload === 'boolean') this.persisted.autoDownload = patch.autoDownload;
    if (typeof patch.installOnQuit === 'boolean') this.persisted.installOnQuit = patch.installOnQuit;
    this.savePersisted();
    this.scheduleTimers();
    this.emit();
    return this.snapshot();
  }

  async dismissVersion(version) {
    if (!this.core) await this.init();
    this.persisted.dismissedVersion = version;
    this.savePersisted();
    this.emit();
    return this.snapshot();
  }

  async prepareInstall({ relaunch = true } = {}) {
    if (!this.core) await this.init();
    if (!this.canInstall) throw Error('UPDATE_INSTALL_UNSUPPORTED');
    const pending = this.persisted?.pendingInstall;
    if (!pending || !pending.filePath || !existsSync(pending.filePath)) {
      throw Error('UPDATE_NOT_READY');
    }
    const actualSha = await this.core.computeFileSha256(pending.filePath);
    if (actualSha !== pending.sha256) {
      this.persisted.pendingInstall = null;
      this.savePersisted();
      this.status = 'error';
      this.error = 'UPDATE_CHECKSUM_MISMATCH';
      this.emit();
      throw Error('UPDATE_CHECKSUM_MISMATCH');
    }

    mkdirSync(this.runnerDir, { recursive: true, mode: 0o700 });
    const runnerApply = join(this.runnerDir, 'apply-update.mjs');
    const runnerCore = join(this.runnerDir, 'updater-core.mjs');
    copyFileSync(resolve(__dirname, 'apply-update.mjs'), runnerApply);
    copyFileSync(resolve(__dirname, 'updater-core.mjs'), runnerCore);
    let runnerNode = null;
    if (this.platform === 'darwin' && this.nodeBin && existsSync(this.nodeBin)) {
      runnerNode = join(this.runnerDir, 'node');
      copyFileSync(this.nodeBin, runnerNode);
      try { chmodSync(runnerNode, 0o755); } catch {}
    }

    const jobPath = join(this.runnerDir, `job-${Date.now()}.json`);
    const job = {
      mode: pending.mode,
      kind: pending.kind,
      fromVersion: this.currentVersion,
      targetVersion: pending.version,
      archivePath: pending.filePath,
      sha256: pending.sha256,
      appDir: this.appDir,
      backupDir: this.platform === 'darwin' ? join(this.updatesDir, 'app.prev') : (this.appDir + '.prev'),
      installDir: this.installDir,
      stateFile: this.stateFile,
      cacheDir: this.cacheDir,
      logFile: this.logFile,
      relaunch: Boolean(relaunch),
      relaunchExe: this.relaunchExe,
      relaunchArgs: this.relaunchArgs,
      waitPids: [process.pid, ...this.getExtraPids()].filter(p => Number.isInteger(p) && p > 0),
    };
    writeJsonAtomic(jobPath, job);
    this.quitJob = { jobPath, runnerApply, runnerNode, relaunch: Boolean(relaunch) };

    if (relaunch) {
      this.status = 'installing';
      this.emit();
      setTimeout(() => this.requestQuit(), 120);
    }
    return this.snapshot();
  }

  async finalizeOnQuit() {
    if (!this.canInstall) return false;
    if (!this.quitJob && this.status === 'ready' && this.persisted?.installOnQuit) {
      try {
        await this.prepareInstall({ relaunch: false });
      } catch {
        return false;
      }
    }
    if (!this.quitJob) return false;
    const { jobPath, runnerApply, runnerNode } = this.quitJob;
    this.quitJob = null;
    const nodeExec = (runnerNode && existsSync(runnerNode)) ? runnerNode : this.nodeBin;
    if (!existsSync(nodeExec) || !existsSync(runnerApply) || !existsSync(jobPath)) return false;
    const child = spawn(nodeExec, [runnerApply, jobPath], {
      cwd: this.runnerDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.unref();
    return true;
  }

  dispose() {
    this.destroyed = true;
    clearTimeout(this.initialTimer);
    clearInterval(this.intervalTimer);
    if (this.downloadAbort) this.downloadAbort.abort();
  }
}

module.exports = { DesktopUpdater, checkStartupRollbackSync };
