// The service itself: how it runs, whether a rebuild is waiting for a restart, and
// restarting it from the web UI.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config, projectRoot } from './config.js';
import type { SystemInfo } from './shared/protocol.js';

const startedAt = Date.now();

/** The systemd unit running this process (from our cgroup), or null when started by hand. */
function systemdUnit(): string | null {
  if (!process.env.INVOCATION_ID) return null;
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.match(/\/([^/\s]+\.service)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const unit = systemdUnit();

/** Newest modification time of the files below `dir` (0 if it does not exist). */
async function newest(dir: string, depth = 6): Promise<number> {
  let latest = 0;
  const walk = async (d: string, level: number) => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (e) => {
        if (e.name === 'node_modules' || e.name.startsWith('.')) return;
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (level < depth) await walk(p, level + 1);
        } else {
          const t = (await stat(p).catch(() => null))?.mtimeMs ?? 0;
          if (t > latest) latest = t;
        }
      }),
    );
  };
  await walk(dir, 0);
  return latest;
}

export async function systemInfo(running: NonNullable<SystemInfo['running']>): Promise<SystemInfo> {
  const [serverBuilt, serverSrc, webBuilt, webSrc] = await Promise.all([
    newest(join(projectRoot, 'server/dist')),
    newest(join(projectRoot, 'server/src')),
    newest(config.webDist),
    newest(join(projectRoot, 'web/src')),
  ]);
  return {
    unit,
    startedAt,
    pid: process.pid,
    // A server build newer than this process only takes effect after a restart.
    rebuiltSinceStart: serverBuilt > startedAt,
    // Source edited after the last build: `npm run build` first, or the restart changes nothing.
    unbuiltChanges: serverSrc > serverBuilt + 1000 || webSrc > webBuilt + 1000,
    busySessions: running.length,
    running,
  };
}

/**
 * Asks systemd to restart the unit. `--no-block` only queues the job: systemctl returns at
 * once, and systemd then stops this process (and everything it started) and starts it again.
 */
export function restartService(): void {
  if (process.env.ANYWHERE_LAB_DISABLE_RESTART === '1') {
    throw new Error('实验环境已禁用网页重启，请在实验虚拟机内管理 anywhere-lab.service');
  }
  if (!unit) throw new Error('服务不是由 systemd 管理的（例如用 npm start 直接启动），请在终端里手动重启');
  // Answer the request first; the restart follows a moment later.
  setTimeout(() => {
    const child = spawn('systemctl', ['--user', 'restart', '--no-block', unit], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error('[restart] systemctl failed:', e.message));
    child.unref();
  }, 300).unref();
}
