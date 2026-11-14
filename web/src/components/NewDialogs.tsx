import { useEffect, useState } from 'react';
import type {
  AgentKind,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  SessionInfo,
  TerminalInfo,
} from '../../../server/src/shared/protocol';
import { api, type Meta } from '../lib/api';
import { EFFORT_LABELS, effortChoices, modelChoices, useModels } from '../lib/models';
import { DirPicker, RemoteDirPicker } from './DirPicker';
import { Button, cx, ErrorText, Modal } from './ui';

export const PERMISSION_MODES: { value: ClaudePermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: '逐项确认', hint: '编辑文件、执行命令前都会在页面上请求你确认（推荐）' },
  { value: 'acceptEdits', label: '自动接受编辑', hint: '文件修改自动通过，执行命令仍需确认' },
  { value: 'auto', label: '智能审批', hint: '由模型分类器自动判断，拿不准时再问你' },
  { value: 'plan', label: '只做计划', hint: '只读分析并给出方案，不修改任何东西' },
  { value: 'bypassPermissions', label: '全部放行', hint: '危险：不做任何确认，直接执行' },
];

export const APPROVAL_POLICIES: { value: CodexApprovalPolicy; label: string; hint: string }[] = [
  { value: 'on-request', label: '需要时询问', hint: '沙箱内的操作自动执行，需要越过沙箱时在页面上问你（推荐）' },
  { value: 'untrusted', label: '每个命令都问', hint: '除了明显安全的只读命令，执行前都要你确认' },
  { value: 'never', label: '从不询问', hint: '不打扰你，超出沙箱的操作直接失败' },
];

export const SANDBOX_MODES: { value: CodexSandboxMode; label: string; hint: string }[] = [
  { value: 'workspace-write', label: '可写工作目录', hint: '只能修改项目目录内的文件（推荐）' },
  { value: 'read-only', label: '只读', hint: '只能读取和分析，不能修改' },
  { value: 'danger-full-access', label: '完全访问', hint: '危险：不受沙箱限制' },
];

const label = 'block text-sm text-zinc-400 mb-1';
const input = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-emerald-500';

export function NewSessionDialog({
  meta,
  initialCwd,
  onClose,
  onCreated,
}: {
  meta: Meta;
  initialCwd?: string;
  onClose: () => void;
  onCreated: (s: SessionInfo) => void;
}) {
  const [agent, setAgent] = useState<AgentKind>(meta.versions.claude ? 'claude' : 'codex');
  const [cwd, setCwd] = useState(initialCwd || meta.roots[0]);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode>('default');
  const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>('danger-full-access');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [approvalPolicy, setApprovalPolicy] = useState<CodexApprovalPolicy>('on-request');
  const models = useModels();
  const choices = effortChoices(models, agent, model);
  const modelList = modelChoices(models, agent);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Worktree: offered when the folder is inside a git repository.
  const [repo, setRepo] = useState<{ branches: string[]; current: string | null } | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [wtBranch, setWtBranch] = useState('');
  const [wtBase, setWtBase] = useState('');
  /** Members: the project folder on their own computer ('' = its home folder until the picker resolves it). */
  const [remoteCwd, setRemoteCwd] = useState('');

  useEffect(() => {
    let stale = false;
    setRepo(null);
    // Members have no repository here (their projects are on their own computer).
    if (meta.home != null) return;
    const t = window.setTimeout(() => {
      api.branches(cwd).then(
        (r) => {
          if (stale) return;
          setRepo(r);
          setWtBase(r.current ?? r.branches[0] ?? '');
        },
        () => !stale && setRepo(null),
      );
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [cwd]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api.createSession({
        agent,
        cwd,
        title: title || undefined,
        options: {
          model,
          effort: effort && choices.efforts.includes(effort) ? effort : undefined,
          ...(agent === 'claude' ? { permissionMode } : { sandboxMode, approvalPolicy }),
        },
        worktree: repo && useWorktree ? { branch: wtBranch.trim() || undefined, base: wtBase || undefined } : undefined,
        ...(meta.home != null && { remoteCwd: remoteCwd || undefined }),
      });
      onCreated(s);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const modes = agent === 'claude' ? PERMISSION_MODES : SANDBOX_MODES;
  const mode = agent === 'claude' ? permissionMode : sandboxMode;
  /** A member account: its sessions work on its own computer, not in a folder here. */
  const member = meta.home != null;

  return (
    <Modal title="新建会话" onClose={onClose}>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2">
          {(['claude', 'codex'] as const).map((a) => {
            const version = meta.versions[a];
            return (
              <button
                key={a}
                type="button"
                disabled={!version}
                onClick={() => {
                  setAgent(a);
                  setModel('');
                  setEffort('');
                }}
                className={cx(
                  'rounded-xl border px-3 py-2.5 text-left disabled:opacity-40',
                  agent === a
                    ? a === 'claude'
                      ? 'border-claude bg-claude/10'
                      : 'border-codex bg-codex/10'
                    : 'border-zinc-700 hover:border-zinc-500',
                )}
              >
                <div className="font-medium">{a === 'claude' ? 'Claude Code' : 'Codex'}</div>
                <div className="truncate text-xs text-zinc-500">{version ?? '未安装'}</div>
              </button>
            );
          })}
        </div>

        {member ? (
          <div>
            <span className={label}>项目文件夹（在你的电脑上）</span>
            {meta.remote ? (
              <div className="space-y-1.5">
                <div className="text-xs text-zinc-500">
                  你的电脑 <span className="font-mono text-zinc-300">{meta.remote.host}{meta.remote.port ? `:${meta.remote.port}` : ''}</span>
                  ：选一个文件夹作为这个会话的项目，AI 一开始就在这个文件夹里工作
                </div>
                <RemoteDirPicker value={remoteCwd} onChange={setRemoteCwd} />
              </div>
            ) : (
              <ErrorText>管理员还没有给你的账号设置电脑（SSH 地址），暂时不能新建会话</ErrorText>
            )}
          </div>
        ) : (
          <div>
            <span className={label}>工作目录</span>
            <DirPicker roots={meta.roots} rootsReal={meta.rootsReal} value={cwd} onChange={setCwd} />
          </div>
        )}

        {!member && repo && (
          <div className={cx('rounded-lg border px-3 py-2', useWorktree ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-zinc-800')}>
            <label className="flex cursor-pointer gap-2.5">
              <input
                type="checkbox"
                className="mt-1 accent-emerald-500"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
              />
              <span>
                <span className="text-sm">在独立的 worktree 里工作</span>
                <span className="block text-xs text-zinc-500">
                  新建一个分支和单独的目录，多个任务同时改这个项目也互不干扰。做完后可以合并回来或创建 PR
                </span>
              </span>
            </label>
            {useWorktree && (
              <div className="mt-2 grid grid-cols-2 gap-2 pl-6">
                <label>
                  <span className={label}>新分支名</span>
                  <input
                    className={cx(input, 'font-mono')}
                    value={wtBranch}
                    onChange={(e) => setWtBranch(e.target.value)}
                    placeholder={`自动：ac/${agent}-…`}
                  />
                </label>
                <label>
                  <span className={label}>基于分支</span>
                  <select className={cx(input, 'font-mono')} value={wtBase} onChange={(e) => setWtBase(e.target.value)}>
                    {repo.branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                        {b === repo.current ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="col-span-2 text-xs text-zinc-500">
                  会自动复制根目录的 .env*、CLAUDE.local.md 和 .worktreeinclude 里列出的文件；node_modules 等依赖需要在新目录里重新安装
                </div>
              </div>
            )}
          </div>
        )}

        {/* A member's Codex has nothing to sandbox here: the work happens on the member's computer. */}
        {!(member && agent === 'codex') && (
        <div>
          <span className={label}>{agent === 'claude' ? '权限模式' : '沙箱模式'}</span>
          <div className="space-y-1.5">
            {modes.map((m) => (
              <label
                key={m.value}
                className={cx(
                  'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2',
                  mode === m.value ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700',
                )}
              >
                <input
                  type="radio"
                  className="mt-1 accent-emerald-500"
                  checked={mode === m.value}
                  onChange={() =>
                    agent === 'claude'
                      ? setPermissionMode(m.value as ClaudePermissionMode)
                      : setSandboxMode(m.value as CodexSandboxMode)
                  }
                />
                <span>
                  <span className="text-sm">{m.label}</span>
                  <span className="block text-xs text-zinc-500">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        )}

        {agent === 'codex' && (
          <label className="block">
            <span className={label}>审批方式</span>
            <select
              className={input}
              value={approvalPolicy}
              onChange={(e) => setApprovalPolicy(e.target.value as CodexApprovalPolicy)}
            >
              {APPROVAL_POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className={label}>推理强度</span>
          <select className={input} value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            <option value="">{choices.defaultLabel}</option>
            {choices.efforts.map((lvl) => (
              <option key={lvl} value={lvl}>
                {EFFORT_LABELS[lvl] ?? lvl}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className={label}>标题（可选）</span>
            <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="默认用目录名" />
          </label>
          <label>
            <span className={label}>模型</span>
            <select className={input} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{modelList.defaultLabel}</option>
              {modelList.options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={create} disabled={busy || !cwd || (meta.home != null && !meta.remote)}>
            创建
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const PRESETS = [
  { label: 'Shell', command: '' },
  { label: 'Claude Code', command: 'claude' },
  { label: 'Codex', command: 'codex' },
  { label: 'lazygit', command: 'lazygit' },
];

export function NewTerminalDialog({
  meta,
  initialCwd,
  onClose,
  onCreated,
}: {
  meta: Meta;
  initialCwd?: string;
  onClose: () => void;
  onCreated: (t: TerminalInfo) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd || meta.roots[0]);
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');

  const create = async () => {
    try {
      onCreated(await api.createTerminal(cwd, command));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="新建终端" onClose={onClose}>
      <div className="space-y-4 p-4">
        <div>
          <span className={label}>工作目录</span>
          <DirPicker roots={meta.roots} rootsReal={meta.rootsReal} value={cwd} onChange={setCwd} />
        </div>
        <div>
          <span className={label}>启动命令</span>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setCommand(p.command)}
                className={cx(
                  'rounded-full border px-2.5 py-1 text-xs',
                  command === p.command ? 'border-emerald-500 text-emerald-300' : 'border-zinc-700 text-zinc-300',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            className={cx(input, 'font-mono text-sm')}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="留空则打开登录 shell"
            autoCapitalize="none"
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={create}>
            打开
          </Button>
        </div>
      </div>
    </Modal>
  );
}
