import { config } from '../config.js';

/**
 * Told to every agent started by this web service (never to plain CLI sessions):
 * the agent runs inside the service, so restarting the service kills it mid-turn.
 */
export function webContext(): string {
  return [
    '[Anywhere Coding] This session is being driven remotely from the Anywhere Coding web UI.',
    `Your process is a child of the "anywhere-coding" systemd user service (PID ${process.pid}, port ${config.port}).`,
    'Restarting, stopping or killing that service or its node process terminates this session in the middle of your turn, so never do it.',
    'If a change needs the service restarted (for example after `npm run build` in the anywhere-coding project), finish all of your work first,',
    'then tell the user to restart it themselves: the 重启服务 button in the user menu (bottom left of the web UI; admin accounts only), or `systemctl --user restart anywhere-coding`.',
    'To try changes to that project, start a separate instance on another port with its own DATA_DIR instead.',
    'The environment variable ANYWHERE_CODING=1 marks this environment. These rules apply only while running under the web service.',
  ].join(' ');
}

/** Bash commands that would restart, stop or kill the service hosting this agent. */
export function isSelfTermination(command: string): boolean {
  const parts = command.split(/;|&&|\|\||\n/);
  return parts.some((p) => {
    if (/\bsystemctl\b/.test(p) && /\b(restart|stop|kill|try-restart|reload-or-restart|disable\s+--now)\b/.test(p) && /anywhere-coding/.test(p)) {
      return true;
    }
    if (/\b(pkill|killall)\b/.test(p) && /(anywhere|server\/dist\/index\.js|\bnode\b)/.test(p)) return true;
    if (/\bkill\b/.test(p)) {
      const pids: string[] = p.match(/\b\d+\b/g) ?? [];
      return pids.includes(String(process.pid)) || pids.includes(String(process.ppid));
    }
    return false;
  });
}

export const SELF_TERMINATION_REASON =
  '已拦截：这个命令会重启/停止 Anywhere Coding 服务，而当前会话正运行在这个服务里，执行会把你自己中断。' +
  '请先完成所有工作，然后告诉用户点网页左下角用户菜单里的「重启服务」，或手动执行 `systemctl --user restart anywhere-coding`。' +
  'Blocked: this would restart/stop the Anywhere Coding service that hosts this session. Finish your work, then ask the user to restart it.';
