// Hands a brief the product advisor wrote to a new coding session in its own worktree.
import { rootsOfId } from './accounts.js';
import { advisorDir, markHandedOff, readBrief } from './advisors.js';
import { tryGit } from './git.js';
import { handoffPrompt } from './agents/advisor.js';
import { GitError } from './git.js';
import { sessions } from './sessions.js';
import type { SessionInfo, SessionOptions } from './shared/protocol.js';
import { createWorktree, type WorktreeMeta } from './worktrees.js';

/** Unless chosen otherwise at hand-off, coding sessions use the "+" menu's Claude presets. */
export const CODING_OPTIONS: SessionOptions = { permissionMode: 'auto', model: 'opus', effort: 'high' };

/**
 * Creates the coding session (a worktree when the project is a git repository), sends the
 * brief as its first message, and records the hand-off on the brief for the advisor to see.
 */
export async function handoffBrief(pm: SessionInfo, file: string, options: SessionOptions = CODING_OPTIONS): Promise<SessionInfo> {
  const memoryDir = advisorDir(pm.project, pm.userId);
  const brief = readBrief(memoryDir, file);
  if (!brief) throw new Error('找不到这份需求书');
  if (brief.status === 'handed_off' && brief.sessionId && sessions.ownerOf(brief.sessionId) === pm.userId) throw new Error('这份需求书已经交接过了');

  let cwd = pm.project;
  let meta: WorktreeMeta | undefined;
  let copied: string[] = [];
  try {
    const wt = await createWorktree(pm.project, { agent: 'pm', roots: rootsOfId(pm.userId) });
    cwd = wt.cwd;
    meta = wt.meta;
    copied = wt.copied;
  } catch (e) {
    // Not a git repository: work in the project folder itself.
    if (!(e instanceof GitError)) throw e;
  }

  const info = sessions.create(pm.userId, 'claude', cwd, brief.title, options, undefined, meta, undefined, { file, advisorId: pm.id });
  sessions.note(
    info.id,
    meta
      ? `已创建 worktree：分支 ${meta.branch}（基于 ${meta.base}），目录 ${meta.path}` +
          (copied.length ? `；已复制本地文件 ${copied.join('、')}` : '') +
          '。这里没有 node_modules 等未跟踪的文件，需要时让 AI 安装依赖'
      : '项目不是 git 仓库，直接在项目目录里工作',
  );
  sessions.note(info.id, `需求书来自「${pm.title}」：${brief.file}。有提交的那一轮结束后会自动把总结汇报给 管家，管家 的回复也会自动转过来`);
  // Commits after this point count as work to report to the advisor.
  sessions.setLoop(info.id, { reportedHead: (await tryGit(cwd, ['rev-parse', 'HEAD'])) ?? undefined });
  await sessions.send(info.id, handoffPrompt(brief));

  markHandedOff(memoryDir, file, { sessionId: info.id, branch: meta?.branch, title: brief.title });
  sessions.emit(pm.id, { type: 'brief', file, title: brief.title, status: 'handed_off', sessionId: info.id, branch: meta?.branch });
  sessions.note(pm.id, `需求书「${brief.title}」已交给编码会话${meta ? `（分支 ${meta.branch}）` : ''}`);
  return sessions.get(info.id)!;
}
