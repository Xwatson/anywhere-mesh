import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Icon, Modal, cx } from '../../../web/src/components/ui';
import './style.css';

type Task = { id: string; title: string; action: string; createdAt: number; state: string; done: boolean; consumed: boolean; error?: string;
  cancelRequested?: boolean; output?: string; resultText?: string; truncated?: boolean; outcome?: string; command?: string; path?: string };
type State = { connection: string; workspace: { label: string; path: string }; permission: { mode: string; localReady: boolean; synced: boolean };
  blockers: number; error: string | null; tasks: Task[]; active: boolean };
type Review = { id: string; title: string; command?: string; path?: string; starts: number; reason: string; digest: string };
declare global { interface Window { desktop: {
  state(): Promise<State>; connect(): Promise<State>; disconnect(): Promise<State>; permission(mode: string): Promise<State>;
  run(action: string): Promise<{ id: string }>; task(id: string): Promise<Task>; cancel(id: string): Promise<Task>;
  reviewPreview(id: string): Promise<Review>; review(id: string, digest: string, note: string): Promise<Task>;
} } }
const modeNames: Record<string, string> = { revoked: '已撤销', read: '只读', edit: '编辑', execute: '执行' };
const states: Record<string, string> = { preparing: '准备中', prepared: '已准备', sent: '等待设备', accepted: '已接收', running: '运行中', cancelling: '取消中',
  succeeded: '已完成', failed: '失败', rejected: '已拒绝', cancelled: '已取消', unknown: '需要本地核对', reviewed: '已核对 · 结果仍未知', interrupted: '提交前中断' };
const errors: Record<string, string> = { READ_FILE_BEFORE_EDIT: '请先读取项目说明，取得当前文件版本。', PERMISSION_REQUIRED: '请先选择相应的本地权限。',
  DEVICE_NOT_READY: '设备尚未连接，或权限还未同步。', REVOKE_BEFORE_REVIEW: '请先撤销权限，再核对这项任务。',
  TASK_IN_PROGRESS_OR_NEEDS_REVIEW: '请等待当前任务结束，或先处理需要核对的任务。', FILE_VERSION_CONFLICT: '文件已被其他程序修改，请重新读取。' };
function App() {
  const [state, setState] = useState<State | null>(null), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState<Review | null>(null), [note, setNote] = useState('');
  const [executePrompt, setExecutePrompt] = useState(false);
  useEffect(() => {
    let alive = true, pending = false;
    const update = async () => { if (pending) return; pending = true;
      try { const next = await window.desktop.state(); if (alive) { setState(next); setSelected(id => id ?? next.tasks[0]?.id ?? null); } }
      catch (e) { if (alive) setError(String(e)); } finally { pending = false; }
    }; update(); const timer = setInterval(update, 900); return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true, pending = false; setDetail(null);
    const update = async () => { if (!selected || pending) return; pending = true;
      try { const task = await window.desktop.task(selected); if (alive) setDetail(task); } catch (e) { if (alive) setError(String(e)); } finally { pending = false; }
    }; update(); const timer = setInterval(update, 700); return () => { alive = false; clearInterval(timer); };
  }, [selected]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(''); try { await fn(); setState(await window.desktop.state()); }
    catch (e) { const raw = String(e); setError(Object.entries(errors).find(([key]) => raw.includes(key))?.[1] ?? raw); }
    finally { setBusy(false); }
  };
  const start = (action: string) => perform(async () => { const task = await window.desktop.run(action); setSelected(task.id); });
  const connected = state?.connection === 'connected', mode = state?.permission.mode ?? 'revoked';
  const usable = connected && state?.permission.synced && !state.active && !state.blockers && !busy;
  return <div className="desktop-shell">
    <aside className="desktop-sidebar">
      <div className="flex items-center gap-3 mb-9"><div className="brand-mark"><Icon name="terminal" className="h-6 w-6" /></div><div><div className="font-semibold tracking-tight text-lg">Anywhere</div><div className="text-xs text-zinc-500">Desktop · Linux</div></div></div>
      <div className="text-xs text-zinc-500 mb-3">本地工作区</div>
      <div className="workspace-item"><Icon name="folder" /><div><div className="text-sm font-medium">Linux 示例项目</div><div className="text-xs text-zinc-500 mt-1">实验虚拟机</div></div></div>
      <div className="mt-4 text-xs text-zinc-500 break-all leading-relaxed">{state?.workspace.path}</div>
      <div className="mt-auto border-t border-zinc-800 pt-5 text-xs text-zinc-500 leading-relaxed"><div className="text-zinc-300 mb-2 flex gap-2 items-center"><Icon name="shield" /> 本机掌握授权</div>权限由本地控制。关闭窗口将撤销权限、收尾任务并断开实验连接。</div>
    </aside>
    <div className="desktop-main">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800 px-7 py-5">
        <div><div className="flex items-center gap-3"><h1 className="text-lg font-semibold">工作区连接</h1><span className="mock-badge">模拟宿主</span></div><p className="text-xs text-zinc-500 mt-1.5">真实文件与隔离命令 · 尚未接入模型 CLI</p></div>
        <div className="flex items-center gap-3"><span className="text-sm text-zinc-400 flex items-center gap-2"><i className={cx('status-dot', connected && 'connected')} />{!state ? '启动中' : connected ? '已连接' : state.connection === 'connecting' ? '连接中' : '未连接'}</span>
          <Button data-testid="connect" disabled={busy || !state} variant={state?.connection === 'disconnected' ? 'primary' : 'secondary'} onClick={() => perform(() => state?.connection === 'disconnected' ? window.desktop.connect() : window.desktop.disconnect())}>{state?.connection === 'disconnected' || !state ? '连接设备' : '断开连接'}</Button></div>
      </header>
      <main className="desktop-content">
        {(error || state?.error) && <div role="alert" className="notice mb-4">{error || state?.error}</div>}
        <section aria-label="本地权限">
          <div className="flex justify-between items-center mb-3"><h2 className="font-medium text-sm">允许远端做什么</h2><span className="text-xs text-zinc-500">{state?.permission.localReady ? state.permission.synced && connected ? '本地生效 · 已同步' : '本地生效 · 等待远端同步' : '本地服务启动中'}</span></div>
          <div className="permission-grid">{[
            ['revoked', 'lock', '撤销', '停止任务并关闭访问'], ['read', 'book', '只读', '查看与搜索项目文件'],
            ['edit', 'edit', '编辑', '允许修改项目文件'], ['execute', 'terminal', '执行', '允许隔离构建和测试'],
          ].map(([key, icon, title, desc]) => <button key={key} data-testid={`mode-${key}`} disabled={busy || !state?.permission.localReady} aria-pressed={mode === key}
            className={cx('permission-card', mode === key && 'selected')} onClick={() => key === 'execute' ? setExecutePrompt(true) : perform(() => window.desktop.permission(key))}>
            <div className="flex items-center justify-between mb-2"><Icon name={icon} /><span className="text-xs">{mode === key ? '当前' : ''}</span></div><div className="font-medium text-sm">{title}</div><div className="text-xs mt-1 text-zinc-500">{desc}</div></button>)}</div>
        </section>
        <section className="mt-6" aria-label="验证任务"><div className="flex justify-between items-center mb-3"><h2 className="font-medium text-sm">验证工作流</h2><span className="text-xs text-zinc-500">当前权限：{modeNames[mode]}</span></div>
          <div className="flex flex-wrap gap-2">
            <Button data-testid="run-read" disabled={!usable || mode === 'revoked'} onClick={() => start('read')}><Icon name="book" />读取说明</Button>
            <Button data-testid="run-edit" disabled={!usable || !['edit', 'execute'].includes(mode)} onClick={() => start('edit')}><Icon name="edit" />追加记录</Button>
            <Button data-testid="run-build" disabled={!usable || mode !== 'execute'} onClick={() => start('build')}><Icon name="terminal" />构建与测试</Button>
            <Button data-testid="run-long" disabled={!usable || mode !== 'execute'} onClick={() => start('long')}>运行长任务</Button>
          </div><p className="text-xs text-zinc-500 mt-3">编辑前先读取文件。构建命令仅访问该项目，网络关闭。</p>
        </section>
        <section className="task-section" aria-label="任务记录"><div className="flex items-center justify-between mb-3"><h2 className="font-medium text-sm">任务记录</h2><span className="text-xs text-zinc-500">最近 50 项 · 保留历史回执</span></div>
          <div className="task-layout"><div className="task-list">{state?.tasks.length ? state.tasks.map(task => <button key={task.id} data-testid={`task-${task.id}`} className={cx('task-row', selected === task.id && 'active')} onClick={() => setSelected(task.id)}>
            <div className="text-sm font-medium truncate">{task.title}</div><div className="flex justify-between gap-2 text-xs mt-2"><span className={cx(task.state === 'succeeded' ? 'text-emerald-400' : task.state === 'unknown' ? 'text-amber-300' : 'text-zinc-500')}>{task.cancelRequested && !task.done ? '正在取消' : states[task.state] ?? task.state}</span><span className="text-zinc-600">{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div>
          </button>) : <div className="p-5 text-xs text-zinc-500 leading-6">连接后选择权限，再启动第一项验证任务。</div>}</div>
          <div className="task-detail">{detail ? <><div className="flex justify-between gap-3 items-center border-b border-zinc-800 p-4"><div><div className="text-sm font-medium">{detail.title}</div><div className="text-xs text-zinc-500 mt-1" data-testid="task-state">{states[detail.state] ?? detail.state}{detail.consumed ? ' · 结果已保存' : ''}</div></div>
            {!detail.done && detail.state !== 'unknown' && <Button data-testid="cancel" variant="danger" disabled={busy || detail.cancelRequested} onClick={() => perform(() => window.desktop.cancel(detail.id))}>取消任务</Button>}
            {detail.state === 'unknown' && <Button data-testid="review-open" variant="primary" disabled={busy || mode !== 'revoked'} onClick={() => perform(async () => { setReview(await window.desktop.reviewPreview(detail.id)); setNote(''); })}>本地核对</Button>}</div>
            {detail.state === 'unknown' && <div className="notice m-4">无法确定任务最终结果。先撤销权限并检查文件，再本地核对；原任务不会自动重试。</div>}
            {detail.state === 'reviewed' && <div className="notice m-4">已按本地核对结论关闭。执行结果仍标记为未知，没有重跑原任务。</div>}
            {detail.truncated && <div className="text-xs text-amber-300 px-4 pt-3">较早输出已截断，以下显示保留的末尾日志。</div>}
            <pre data-testid="task-output" className="task-output">{detail.command ? `$ ${detail.command}\n\n` : detail.path ? `${detail.path}\n\n` : ''}{detail.output || detail.resultText || '等待任务输出…'}{detail.error ? `\n${detail.error}` : ''}</pre>
          </> : <div className="empty-detail"><Icon name="terminal" className="h-8 w-8 text-zinc-700" /><div className="mt-3 text-sm text-zinc-500">任务输出将在这里显示</div></div>}</div></div>
        </section>
      </main>
      <footer className="px-7 py-3 border-t border-zinc-800 text-xs text-zinc-600 flex justify-between"><span>Linux 桌面最小验证版</span><span>关闭窗口即退出 · 不驻留托盘</span></footer>
    </div>
    {executePrompt && <Modal title="允许执行项目命令" onClose={() => setExecutePrompt(false)}><div className="p-5"><p className="text-sm text-zinc-300 leading-7">将允许远端在此项目内执行命令和修改文件。任务在隔离环境中运行，不能联网；你可以随时撤销并停止任务。</p><p className="text-xs text-zinc-500 mt-3 break-all">{state?.workspace.path}</p><div className="flex justify-end gap-2 mt-5"><Button onClick={() => setExecutePrompt(false)}>取消</Button><Button data-testid="confirm-execute" variant="primary" onClick={() => { setExecutePrompt(false); perform(() => window.desktop.permission('execute')); }}>允许执行</Button></div></div></Modal>}
    {review && <Modal title="本地核对结果不确定的任务" onClose={() => setReview(null)}><form className="p-5" onSubmit={e => { e.preventDefault(); perform(async () => { await window.desktop.review(review.id, review.digest, note); setReview(null); }); }}>
      <p className="text-sm text-zinc-300 leading-7">请在本地检查任务涉及的文件和进程，再记录你观察到的结果。此操作关闭待核对状态，执行结果仍保留为未知。</p>
      <div className="my-4 rounded-lg bg-zinc-950 p-3 text-xs text-zinc-400 break-all leading-6">{review.title}<br />{review.path || review.command}<br />启动次数：{review.starts} · 原因：{review.reason}</div>
      <label className="block text-sm mb-2" htmlFor="review-note">本地核对记录</label><textarea id="review-note" data-testid="review-note" value={note} onChange={e => setNote(e.target.value)} maxLength={2048} required rows={4} placeholder="已检查哪些文件，观察到了什么？" className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm focus:outline-emerald-500" />
      <div className="flex justify-end gap-2 mt-4"><Button type="button" onClick={() => setReview(null)}>取消</Button><Button type="submit" data-testid="review-submit" variant="primary" disabled={!note.trim() || busy}>保存核对并关闭</Button></div>
    </form></Modal>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
