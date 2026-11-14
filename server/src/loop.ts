// The exchange between a product advisor and the coding sessions started from its briefs:
// a coding session's summary goes to the advisor once it has committed, the part of the
// advisor's answer addressed to the coding session goes back, "可以合并" reaches the user,
// merges and pull requests are reported, briefs marked 可开工 are handed off by themselves
// (within the project's limits), and the advisor patrols on a timer.
import { advisorDir, listBriefs, readAdvisorSettings } from './advisors.js';
import { PATROL_PROMPT, RESUME_AFTER_RESTART, STEWARD_CHECK_IN_AFTER_RESTART, STEWARD_RESUME_AFTER_RESTART } from './agents/advisor.js';
import { getUsage } from './external/usage.js';
import { tryGit } from './git.js';
import { CODING_OPTIONS, handoffBrief } from './handoff.js';
import { pushUser } from './push.js';
import { sessions } from './sessions.js';
import type { AdvisorSettings, Progress, ProgressItem, SessionInfo } from './shared/protocol.js';
import { mergeWorktree, removeWorktree } from './worktrees.js';

/** Advisor replies forwarded to one coding session automatically before a human has to step in. */
const MAX_ROUNDS = 4;
const REPORT_TAG = '[编码会话汇报]';
const RELAY_TAG = '[管家回复]';
const DAY = 24 * 3600e3;

/** Sessions started from a brief (older ones recognisable by their branch name). */
export const fromBrief = (s: SessionInfo) => !!s.brief || !!s.worktree?.branch.startsWith('ac/pm-');

/**
 * The advisor a coding session reports to: its account's current one of the project (a restarted
 * conversation takes over), else the one it came from. Never another account's.
 */
export function advisorFor(s: SessionInfo): SessionInfo | null {
  const pm = sessions.advisorOf(s.project, s.userId) || (s.brief && sessions.get(s.brief.advisorId));
  return pm && pm.id !== s.id && pm.userId === s.userId ? pm : null;
}

/** The advisor's memory folder. */
const memoryOf = (pm: SessionInfo) => advisorDir(pm.project, pm.userId);

const where = (s: SessionInfo) =>
  [s.worktree ? `分支 ${s.worktree.branch}` : '', s.brief ? `需求书 ${s.brief.file}` : ''].filter(Boolean).join('，');

/** Sends a coding session's report to its advisor and arranges for the answer to come back. */
export async function report(s: SessionInfo, pm: SessionInfo, text: string, auto: boolean) {
  const w = where(s);
  await sessions.send(
    pm.id,
    `${REPORT_TAG} 「${s.title}」${w ? `（${w}）` : ''}：\n\n${text}\n\n` +
      '请据此更新记忆和待办。有要交代编码会话的，写在「## 给编码会话」标题下，会原样自动转给它；合并、推送、部署由我决定，不要让它做。',
  );
  sessions.setLoop(s.id, { reportedHead: (await tryGit(s.cwd, ['rev-parse', 'HEAD'])) ?? undefined });
  sessions.setLoop(pm.id, { pendingRelay: s.id });
  sessions.note(s.id, auto ? '已自动汇报给管家' : '已把汇报转给管家');
}

/** The user merged the session's branch from the web: the advisor closes the item. */
export async function mergedReport(s: SessionInfo, summary: string) {
  sessions.setLoop(s.id, { merged: true });
  const pm = fromBrief(s) ? advisorFor(s) : null;
  if (!pm) return;
  // The branch is in; the worktree and branch are only clutter now (the session stays as history).
  const meta = sessions.worktreeOf(s.id);
  if (meta && readAdvisorSettings(memoryOf(pm)).cleanupAfterMerge) {
    sessions.release(s.id);
    try {
      await removeWorktree(meta, { deleteBranch: true });
      sessions.note(s.id, 'worktree 和分支已清理，会话保留为历史');
    } catch (e) {
      sessions.note(s.id, `worktree 清理失败：${(e as Error).message}`);
    }
  }
  const w = where(s);
  await sessions.send(
    pm.id,
    `[编码会话已合并] 「${s.title}」${w ? `（${w}）` : ''}已合并进 ${s.worktree?.base ?? '基础分支'}：${summary}\n\n请把对应的待办改成已完成，决策日志记一笔；有后续建议直接对我说。`,
  );
  sessions.note(s.id, '已通知管家：分支已合并');
  await maybeAutoHandoff(pm);
}

/** The user opened a pull request for the session's branch. */
export async function prReport(s: SessionInfo, url: string) {
  sessions.setLoop(s.id, { merged: true });
  const pm = fromBrief(s) ? advisorFor(s) : null;
  if (!pm) return;
  await sessions.send(pm.id, `[编码会话已建 PR] 「${s.title}」（${where(s)}）：${url}\n\n请把对应的待办改成「待合并」；有后续建议直接对我说。`);
  sessions.note(s.id, '已通知管家：PR 已创建');
  await maybeAutoHandoff(pm);
}

/** The user closed a brief's session that has nothing to merge (e.g. a deployment task): the slot is free. */
export async function finishReport(s: SessionInfo) {
  sessions.setLoop(s.id, { merged: true });
  sessions.note(s.id, '已结束：没有要合并的改动');
  const pm = fromBrief(s) ? advisorFor(s) : null;
  if (!pm) return;
  await sessions.send(pm.id, `[编码会话已结束] 「${s.title}」（${where(s)}）没有要合并的改动，用户已把它结束。请把对应的待办改成已完成，决策日志记一笔。`);
  await maybeAutoHandoff(pm);
}

const assistantText = (events: { event: { type: string; text?: string } }[]) =>
  events
    .filter((e) => e.event.type === 'assistant_text')
    .map((e) => e.event.text ?? '')
    .join('\n\n')
    .trim();

/**
 * Every "给编码会话" section of an advisor reply (a heading, or a bold line), each with the branch or
 * title it names after the words, if any. A heading-led section runs to the next heading; a
 * bold-label-led one also ends at the next bold label.
 */
export function extractForCoders(reply: string): { target?: string; text: string }[] {
  const lines = reply.split('\n');
  const out: { target?: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    const m = head.match(/^(#{2,}\s*|\*\*)\s*(?:可以直接转给|转给|给)编码会话(?:的话)?\s*[:：]?\s*([^*\n]*?)\s*\**\s*[:：]?\s*$/);
    if (!m) continue;
    const boldLed = head.startsWith('**');
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^#{1,6}\s/.test(l) || (boldLed && /^\*\*[^*\n]+\*\*[:：]/.test(l.trim()))) break;
      body.push(l.replace(/^>\s?/, ''));
    }
    const text = body.join('\n').trim();
    if (text) out.push({ target: m[2].replace(/^[「《]|[」》]$/g, '').trim() || undefined, text });
    i = j - 1;
  }
  return out;
}

/** Kept for callers that only want the first section's text. */
export function extractForCoder(reply: string): string {
  return extractForCoders(reply)[0]?.text ?? '';
}

/** The coding session of the advisor's project (and account) a section names (by branch, then by title). */
function coderNamed(pm: SessionInfo, target: string): SessionInfo | undefined {
  const mine = sessions.list(pm.userId).filter((s) => s.id !== pm.id && s.project === pm.project && fromBrief(s));
  const t = target.toLowerCase();
  return (
    mine.find((s) => s.worktree?.branch.toLowerCase() === t) ??
    mine.find((s) => s.worktree?.branch.toLowerCase().includes(t)) ??
    mine.find((s) => s.title.includes(target))
  );
}

/** A coding session finished a turn: report it when it was answering the advisor or has new commits. */
async function afterCodingTurn(s: SessionInfo) {
  if (!fromBrief(s) || !s.inWorkspace) return;
  const pm = advisorFor(s);
  if (!pm) return;
  const turn = sessions.lastTurn(s.id);
  const end = turn.events.findLast((e) => e.event.type === 'turn_end')?.event;
  if (!end || end.type !== 'turn_end' || !end.ok) return;
  const text = assistantText(turn.events);
  if (!text) return;
  const head = await tryGit(s.cwd, ['rev-parse', 'HEAD']);
  const committed = !!head && head !== sessions.getLoop(s.id).reportedHead;
  // Turns the steward or the system started are always reported (questions included); a chat the user
  // started with the session only when it committed — the card stays for a manual report otherwise.
  const byUser = !!turn.user && !turn.user.startsWith(RELAY_TAG) && !turn.user.startsWith('[系统]') && !/^这是(项目管家|产品经理（PM）)写的需求书/.test(turn.user);
  if (byUser && !committed) return;
  await report(s, pm, text, true);
}

/** Why automation must pause right now, or null. */
async function quotaBlock(settings: AdvisorSettings): Promise<string | null> {
  const usage = await getUsage().catch(() => null);
  const hot = usage?.claude.ok ? usage.claude.windows.find((w) => w.usedPercent >= settings.quotaStopPercent) : undefined;
  return hot ? `Claude 额度（${hot.label}）已用 ${hot.usedPercent}%，达到 ${settings.quotaStopPercent}% 的刹车线` : null;
}

/** Coding sessions of the advisor's project (and account) that are still open: not merged, worktree still there. */
const activeCoders = (pm: SessionInfo) =>
  sessions
    .list(pm.userId)
    .filter((s) => s.id !== pm.id && s.project === pm.project && fromBrief(s) && !sessions.getLoop(s.id).merged && (!s.worktree || s.worktree.exists));

/** A waiting reason is noted once, not again on every sweep. */
function noteOnce(pm: SessionInfo, text: string) {
  if (sessions.getLoop(pm.id).lastAutoNote === text) return;
  sessions.setLoop(pm.id, { lastAutoNote: text });
  sessions.note(pm.id, text);
}

/** Hands off the oldest brief marked 可开工, within the project's limits. Safe to call any time. */
export async function maybeAutoHandoff(pm: SessionInfo) {
  const settings = readAdvisorSettings(memoryOf(pm));
  if (!settings.autoHandoff || !pm.inWorkspace) return;
  const ready = listBriefs(memoryOf(pm))
    .filter((b) => b.status === 'new' && b.ready)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  if (!ready.length) return;
  const busy = activeCoders(pm);
  if (busy.length >= settings.maxConcurrent) {
    noteOnce(pm, `自动交接等待中：${ready.length} 份可开工的需求书，但「${busy[0].title}」还没合并或结束（同时最多 ${settings.maxConcurrent} 个）`);
    return;
  }
  const recent = (sessions.getLoop(pm.id).autoHandoffs ?? []).filter((t) => Date.now() - t < DAY);
  if (recent.length >= settings.dailyLimit) {
    noteOnce(pm, `自动交接暂停：24 小时内已自动开工 ${recent.length} 次，达到每天 ${settings.dailyLimit} 次的上限`);
    return;
  }
  const block = await quotaBlock(settings);
  if (block) {
    noteOnce(pm, `自动交接暂停：${block}`);
    return;
  }
  const brief = ready[0];
  const info = await handoffBrief(pm, brief.file, CODING_OPTIONS);
  sessions.setLoop(pm.id, { autoHandoffs: [...recent, Date.now()], lastAutoNote: undefined });
  sessions.note(pm.id, `已自动开工：「${brief.title}」→ 编码会话${info.worktree ? `（分支 ${info.worktree.branch}）` : ''}`);
  pushUser(pm.userId, { title: pm.title, body: `已自动开工：${brief.title}`, tag: info.id, url: `/#/s/${info.id}` });
}

/** The advisor finished a turn: forward what it addressed to the coding session, then look for work to start. */
/** Forwards one section of the advisor's reply to a coding session, within the round limit. */
async function relay(pm: SessionInfo, coder: SessionInfo, text: string) {
  const rounds = (sessions.getLoop(coder.id).rounds ?? 0) + 1;
  if (rounds > MAX_ROUNDS) {
    sessions.note(pm.id, `和「${coder.title}」已自动往返 ${MAX_ROUNDS} 轮，这段没有转过去；需要的话让用户手动转`);
    return;
  }
  if (!coder.inWorkspace || (coder.worktree && !coder.worktree.exists)) {
    sessions.note(pm.id, `「${coder.title}」已不能运行，这段没有转过去`);
    return;
  }
  sessions.setLoop(coder.id, { rounds });
  await sessions.send(coder.id, `${RELAY_TAG} 管家的话，请照做；做完照常总结。\n\n${text}`);
  sessions.note(pm.id, `已转给编码会话「${coder.title}」`);
}

async function afterAdvisorTurn(pm: SessionInfo) {
  const { pendingRelay } = sessions.getLoop(pm.id);
  const turn = sessions.lastTurn(pm.id);
  const reply = assistantText(turn.events);
  const answering = pendingRelay && turn.user?.startsWith(REPORT_TAG) ? sessions.get(pendingRelay) : null;
  if (answering) sessions.setLoop(pm.id, { pendingRelay: undefined });
  // Sections addressed to coding sessions: named ones anywhere, unnamed ones to the session being answered.
  for (const { target, text } of extractForCoders(reply)) {
    const coder = target ? coderNamed(pm, target) : answering;
    if (!coder) {
      sessions.note(pm.id, target ? `没有找到叫「${target}」的编码会话，这段没有转出去` : '这段「给编码会话」没有对象（不是在回复汇报），没有转出去');
      continue;
    }
    await relay(pm, coder, text);
  }
  if (answering) {
    const coder = answering;
    {
      if (/可以合并|验收通过|同意合并/.test(reply)) {
        sessions.setLoop(coder.id, { approved: true });
        const meta = sessions.worktreeOf(coder.id);
        const ahead = meta ? Number((await tryGit(meta.repo, ['rev-list', '--count', `${meta.base}..${meta.branch}`])) ?? 0) : 0;
        if (meta && ahead === 0 && !sessions.isBusy(coder.id)) {
          // Nothing to merge (a deployment or check): accepted means finished.
          sessions.setLoop(coder.id, { merged: true });
          sessions.note(coder.id, '管家验收通过，没有要合并的改动，已结束');
          if (readAdvisorSettings(memoryOf(pm)).cleanupAfterMerge && coder.worktree?.exists) {
            sessions.release(coder.id);
            await removeWorktree(meta, { deleteBranch: true }).then(
              () => sessions.note(coder.id, 'worktree 和分支已清理，会话保留为历史'),
              (e: Error) => sessions.note(coder.id, `worktree 清理失败：${e.message}`),
            );
          }
          await maybeAutoHandoff(pm);
        } else if (readAdvisorSettings(memoryOf(pm)).autoMerge && meta && coder.worktree?.exists && !sessions.isBusy(coder.id)) {
          try {
            const summary = await mergeWorktree(meta);
            await mergedReport(coder, summary);
            sessions.note(coder.id, `管家说可以合并，已自动合并进 ${meta.base}：${summary}`);
            pushUser(coder.userId, { title: coder.title, body: `已自动合并进 ${meta.base}`, tag: coder.id, url: `/#/s/${coder.id}` });
          } catch (e) {
            sessions.note(coder.id, `管家说可以合并，但自动合并失败：${(e as Error).message}。请到 worktree 面板手动处理`);
            pushUser(coder.userId, { title: coder.title, body: `自动合并失败：${(e as Error).message}`, tag: coder.id, url: `/#/s/${coder.id}` }, 'high');
          }
        } else {
          sessions.note(coder.id, '管家：可以合并。到 worktree 面板里合并或创建 PR');
          pushUser(coder.userId, { title: coder.title, body: '管家看过了：可以合并', tag: coder.id, url: `/#/s/${coder.id}` });
        }
      }
    }
  }
  if (pm.inWorkspace) await maybeAutoHandoff(pm);
}

/** Where every brief of the advisor's project stands, and one line of conclusion for the user. */
export async function progress(pm: SessionInfo): Promise<Progress> {
  const items: ProgressItem[] = [];
  for (const b of listBriefs(memoryOf(pm))) {
    const base = { file: b.file, title: b.title, updatedAt: b.updatedAt };
    if (b.status !== 'handed_off') {
      items.push({ ...base, stage: b.ready ? 'ready' : 'pending' });
      continue;
    }
    const found = b.sessionId ? sessions.get(b.sessionId) : null;
    const s = found?.userId === pm.userId ? found : null;
    if (!s) {
      // The session is gone but its branch may already be in the project: then the work is done.
      let merged = false;
      if (b.branch) {
        const ref = `refs/heads/${b.branch}`;
        const tip = await tryGit(pm.project, ['rev-parse', '--verify', '--quiet', ref]);
        const created = (await tryGit(pm.project, ['reflog', '--format=%H', ref]))?.split('\n').pop();
        const inHead = tip ? (await tryGit(pm.project, ['merge-base', '--is-ancestor', ref, 'HEAD'])) !== null : false;
        merged = inHead && !!created && tip !== created;
      }
      items.push({ ...base, stage: merged ? 'merged' : 'orphaned', sessionId: b.sessionId, branch: b.branch });
      continue;
    }
    const loop = sessions.getLoop(s.id);
    let commits: number | undefined;
    let absorbed = false;
    if (s.worktree) {
      const { repo, base, branch } = s.worktree;
      commits = Number((await tryGit(repo, ['rev-list', '--count', `${base}..${branch}`])) ?? 0);
      // Merged outside the web (or before merges were tracked): the branch moved since it was created,
      // yet nothing on it is missing from the base any more.
      const tip = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      const created = (await tryGit(repo, ['reflog', '--format=%H', `refs/heads/${branch}`]))?.split('\n').pop();
      absorbed = commits === 0 && !!tip && !!created && tip !== created;
    }
    const approved = loop.approved || sessions.hasNotice(s.id, '管家：可以合并') || sessions.hasNotice(s.id, '管家：可以合并');
    const stage = loop.merged || absorbed ? 'merged' : s.status === 'waiting' ? 'waiting_user' : approved ? 'approved' : 'working';
    items.push({ ...base, stage, sessionId: s.id, sessionStatus: s.status, branch: s.worktree?.branch, commits });
  }
  const n = (stage: ProgressItem['stage']) => items.filter((i) => i.stage === stage).length;
  const mine = [
    n('waiting_user') && `${n('waiting_user')} 项等你回答`,
    n('approved') && `${n('approved')} 项等你合并`,
    n('orphaned') && `${n('orphaned')} 项的会话已删除、要不要重做由你定`,
  ].filter(Boolean) as string[];
  const rest = [
    n('working') && `${n('working')} 项进行中`,
    n('ready') && `${n('ready')} 项排队待开工`,
    n('pending') && `${n('pending')} 项待议`,
    n('merged') && `${n('merged')} 项已合并`,
  ].filter(Boolean) as string[];
  const summary = !items.length
    ? '还没有需求书'
    : (mine.length ? `需要你：${mine.join('，')}。` : '没有要你做的事。') + (rest.length ? `不用管：${rest.join('，')}` : '');
  return { items, summary, attention: n('waiting_user') + n('approved') + n('orphaned') };
}

// A restart killed every agent mid-turn: tell the ones that were working to pick up where they stopped.
setTimeout(() => {
  for (const id of sessions.interruptedAtStart) {
    const s = sessions.get(id);
    if (!s || !s.inWorkspace || (s.worktree && !s.worktree.exists)) continue;
    const steward = s.role === 'advisor';
    if (!steward && !fromBrief(s)) continue;
    sessions.send(id, steward ? STEWARD_RESUME_AFTER_RESTART : RESUME_AFTER_RESTART).catch((e: Error) => sessions.note(id, `重启后没能继续：${e.message}`));
  }
  // Stewards with open coding sessions look around after a restart, so nothing stays stuck unnoticed.
  for (const pm of currentAdvisors()) {
    if (!pm.inWorkspace || sessions.interruptedAtStart.includes(pm.id) || !activeCoders(pm).length) continue;
    sessions.send(pm.id, STEWARD_CHECK_IN_AFTER_RESTART).catch(() => {});
  }
}, 15_000).unref();

sessions.onIdle((info) => {
  const job = info.role === 'advisor' ? afterAdvisorTurn(info) : afterCodingTurn(info);
  job.catch((e: Error) => sessions.note(info.id, `自动中继失败：${e.message}`));
});

// ---- patrol: each project's current advisor looks around by itself, on its own schedule

/** Each account's current advisor of each project (the newest one). */
function currentAdvisors(): SessionInfo[] {
  const byProject = new Map<string, SessionInfo>();
  for (const s of sessions.list()) {
    if (s.role !== 'advisor') continue;
    const key = `${s.userId}\0${s.project}`;
    const cur = byProject.get(key);
    if (!cur || s.createdAt > cur.createdAt) byProject.set(key, s);
  }
  return [...byProject.values()];
}

async function patrolTick() {
  for (const pm of currentAdvisors()) {
    if (!pm.inWorkspace || pm.status !== 'idle') continue;
    const settings = readAdvisorSettings(memoryOf(pm));
    // Safety net for hand-offs whose trigger was missed (a session deleted by hand, a restart).
    if (settings.autoHandoff) await maybeAutoHandoff(pm).catch((e: Error) => sessions.note(pm.id, `自动交接失败：${e.message}`));
    if (!settings.patrol) continue;
    const last = sessions.getLoop(pm.id).lastPatrolAt ?? 0;
    if (Date.now() - last < settings.patrolHours * 3600e3) continue;
    const block = await quotaBlock(settings);
    sessions.setLoop(pm.id, { lastPatrolAt: Date.now() });
    if (block) {
      sessions.note(pm.id, `这次巡视跳过：${block}`);
      continue;
    }
    await sessions.send(pm.id, PATROL_PROMPT).catch((e: Error) => sessions.note(pm.id, `巡视没能开始：${e.message}`));
  }
}

setInterval(() => void patrolTick().catch(() => {}), 10 * 60_000).unref();
