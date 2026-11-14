import { useEffect, useState, type FormEvent } from 'react';
import type { AccountInfo } from '../../../server/src/shared/protocol';
import { api, ApiError, type User } from '../lib/api';
import { pushEndpoint } from '../lib/push';
import { Button, CopyButton, cx, ErrorText, Icon, Modal, shortPath } from './ui';

/**
 * Runs an account change; when the member's folder (<workspace>/<name>) already exists, asks whether
 * the account should take it over and, if so, runs it again with permission to.
 */
async function adoptingFolder<T>(fn: (adopt: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await fn(false);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'folder_exists') throw e;
    if (!confirm(`${e.message}。\n\n如果这个文件夹是别的项目或者别人的文件，请取消，换一个用户名。继续让这个账号使用它吗？`)) return null;
    return fn(true);
  }
}

const field = 'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500';
const input = `w-full ${field}`;

/** A password to hand over: 12 characters without look-alikes (0/O, 1/l/I). */
function randomPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function when(ts: number | null) {
  if (!ts) return '从未登录';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? `今天 ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 登录`
    : `${d.toLocaleDateString()} 登录`;
}

/** Shown once after a password was set, so the admin can pass it on. */
function Credentials({ username, password, onDone }: { username: string; password: string; onDone: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
      <div className="text-emerald-200">把下面的账号和密码发给对方，这里只显示这一次：</div>
      <div className="flex items-center gap-2 rounded-md bg-zinc-950 px-2 py-1.5 font-mono text-zinc-100">
        <span className="min-w-0 flex-1 truncate">
          {username} / {password}
        </span>
        <CopyButton text={`用户名：${username}\n密码：${password}\n登录后可以在左下角菜单的「修改密码」里改成自己的密码。`} label />
      </div>
      <button onClick={onDone} className="text-xs text-zinc-400 hover:text-zinc-200">
        知道了
      </button>
    </div>
  );
}

/** Password field with a "generate" button; generated passwords are shown in clear text. */
function PasswordInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="至少 8 位"
        className={cx(input, 'font-mono')}
      />
      <Button
        type="button"
        className="shrink-0"
        onClick={() => {
          onChange(randomPassword());
          setShown(true);
        }}
      >
        生成
      </Button>
    </div>
  );
}

/** A member's computer: SSH address and port, with a connection test. */
function RemoteFields({
  host,
  port,
  onHost,
  onPort,
}: {
  host: string;
  port: string;
  onHost: (v: string) => void;
  onPort: (v: string) => void;
}) {
  const [test, setTest] = useState<{ ok: boolean; output: string } | 'testing' | null>(null);
  const run = async () => {
    setTest('testing');
    try {
      setTest(await api.testRemote(host.trim(), port.trim() ? Number(port) : null));
    } catch (e) {
      setTest({ ok: false, output: (e as Error).message });
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          value={host}
          onChange={(e) => (onHost(e.target.value), setTest(null))}
          placeholder="他的电脑：用户名@IP，如 liuxiaojing@10.144.144.4"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className={cx(field, 'min-w-0 flex-1 font-mono')}
        />
        <input
          value={port}
          onChange={(e) => (onPort(e.target.value.replace(/\D/g, '')), setTest(null))}
          placeholder="端口"
          inputMode="numeric"
          className={cx(field, 'w-20 shrink-0 font-mono')}
        />
        <Button type="button" className="shrink-0" disabled={!host.trim() || test === 'testing'} onClick={run}>
          {test === 'testing' ? '连接中…' : '测试'}
        </Button>
      </div>
      {test && test !== 'testing' && <div className={cx('text-xs', test.ok ? 'text-emerald-400' : 'text-red-300')}>{test.output}</div>}
      <div className="text-xs text-zinc-500">
        AI 通过 SSH 连接这台电脑，只在它上面工作。需要先把这台服务器的公钥（~/.ssh/id_ed25519.pub）加进那台电脑的 ~/.ssh/authorized_keys，免密登录；也可以填 ~/.ssh/config 里的 Host 别名。
      </div>
    </div>
  );
}

function AddAccount({ onAdded }: { onAdded: (list: AccountInfo[], username: string, password: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const name = username.trim();
      const remote = !isAdmin && host.trim() ? { remoteHost: host.trim(), remotePort: port ? Number(port) : null } : {};
      const next = await adoptingFolder((adoptFolder) => api.addAccount({ username: name, password, isAdmin, adoptFolder, ...remote }));
      if (!next) return;
      onAdded(next, name, password);
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      setHost('');
      setPort('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 border-b border-zinc-800 px-4 py-3">
      <div className="text-sm font-medium">添加账号</div>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="用户名"
        autoCapitalize="none"
        autoComplete="off"
        className={input}
      />
      <PasswordInput value={password} onChange={setPassword} />
      {!isAdmin && <RemoteFields host={host} port={port} onHost={setHost} onPort={setPort} />}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} className="accent-emerald-500" />
          管理员
        </label>
        <Button variant="primary" type="submit" className="ml-auto" disabled={busy || !username.trim() || !password}>
          {busy ? '添加中…' : '添加'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function AccountRow({
  account,
  me,
  onChanged,
  onPassword,
}: {
  account: AccountInfo;
  me: User;
  onChanged: (list: AccountInfo[]) => void;
  onPassword: (username: string, password: string) => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [editingRemote, setEditingRemote] = useState(false);
  const [host, setHost] = useState(account.remote?.host ?? '');
  const [port, setPort] = useState(account.remote?.port ? String(account.remote.port) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const self = account.id === me.id;

  const saveRemote = async (clear = false) => {
    const running = account.busySessions > 0 ? `\n\n它正在运行的 ${account.busySessions} 个会话会被停止（之后发消息即可继续）。` : '';
    if (clear && !confirm(`清除 ${account.username} 的电脑？清除后它不能再新建会话或继续对话，直到重新设置。${running}`)) return;
    if (!clear && account.busySessions > 0 && !confirm(`换成新的电脑后，${account.username} 已经打开的会话下一条消息起就在新电脑上工作。${running}`)) return;
    const patch = clear ? { remoteHost: null } : { remoteHost: host.trim(), remotePort: port ? Number(port) : null };
    if (await run(() => api.updateAccount(account.id, patch))) setEditingRemote(false);
  };

  const run = async (fn: () => Promise<AccountInfo[]>) => {
    setBusy(true);
    setError('');
    try {
      onChanged(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.updateAccount(account.id, { password }))) {
      onPassword(account.username, password);
      setResetting(false);
      setPassword('');
    }
  };

  const toggleAdmin = () => {
    const running = account.busySessions > 0 ? `\n\n它正在运行的 ${account.busySessions} 个会话会被停止（之后发消息即可继续）。` : '';
    const text = account.isAdmin
      ? `取消 ${account.username} 的管理员身份？\n\n之后它的 AI 只能在它自己的电脑上工作（通过 SSH，需要在这里设置电脑），在这台服务器上什么都不能做；也不能再管理账号、查看本机历史、开终端和重启服务。它以前在服务器上的会话变成只读。${running}`
      : `把 ${account.username} 设为管理员？\n\n管理员的 AI 直接在这台服务器上工作：整个工作区、所有命令，并使用这台电脑上 Claude / Codex 的个人设置（~/.claude/CLAUDE.md、插件、MCP 服务器、claude.ai 连接器）。管理员还能添加、删除账号，重置任何人的密码，查看本机历史，开终端，重启服务。${running}`;
    if (!confirm(text)) return;
    void run(async () => (await adoptingFolder((adopt) => api.updateAccount(account.id, { isAdmin: !account.isAdmin, adoptFolder: adopt }))) ?? (await api.accounts()));
  };

  const remove = () => {
    const text = [
      `删除账号 ${account.username}？`,
      `它的 ${account.sessions} 个会话（聊天记录和上传的文件）、管家记忆和终端会一起删除，已登录的设备会退出，推送也会停止。`,
      account.busySessions > 0 && `其中 ${account.busySessions} 个会话正在运行，会被立即停止。`,
      account.home
        ? `它在服务器上的文件夹 ${shortPath(account.home)}（记忆）留在磁盘上，不会删除；它电脑上的文件也不受影响。`
        : '会话用过的 worktree 目录和分支留在磁盘上，不会删除。',
      '删除后不能恢复。',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (confirm(text)) void run(() => api.deleteAccount(account.id));
  };

  const action = 'rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40';
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-sm font-medium uppercase">
          {account.username.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm">{account.username}</span>
            {account.isAdmin && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-300">管理员</span>}
            {self && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">你</span>}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {account.sessions} 个会话{account.busySessions > 0 && <span className="text-emerald-400">（{account.busySessions} 个运行中）</span>}
            {' · '}
            {account.pushDevices ? `${account.pushDevices} 台设备开了推送` : '没开推送'}
            {' · '}
            {when(account.lastLoginAt)}
          </div>
          <div className="flex items-center gap-1 truncate text-xs text-zinc-500">
            <Icon name={account.isAdmin ? 'folder' : 'terminal'} className="h-3 w-3" />
            {account.isAdmin ? (
              <span>这台服务器（整个工作区）</span>
            ) : account.remote ? (
              <span className="truncate font-mono">
                {account.remote.host}
                {account.remote.port ? `:${account.remote.port}` : ''}
              </span>
            ) : (
              <span className="text-amber-300">还没有设置电脑，暂时不能工作</span>
            )}
          </div>
        </div>
      </div>
      {!self && (
        <div className="flex flex-wrap gap-1 pl-11">
          {!account.isAdmin && (
            <button className={action} disabled={busy} onClick={() => setEditingRemote(!editingRemote)}>
              {account.remote ? '换电脑' : '设置电脑'}
            </button>
          )}
          <button className={action} disabled={busy} onClick={() => setResetting(!resetting)}>
            重置密码
          </button>
          <button className={action} disabled={busy} onClick={toggleAdmin}>
            {account.isAdmin ? '取消管理员' : '设为管理员'}
          </button>
          <button className={cx(action, 'text-red-300 hover:bg-red-500/15')} disabled={busy} onClick={remove}>
            删除
          </button>
        </div>
      )}
      {editingRemote && (
        <div className="space-y-2 pl-11">
          <RemoteFields host={host} port={port} onHost={setHost} onPort={setPort} />
          <div className="flex items-center gap-2">
            {account.remote && (
              <Button type="button" variant="ghost" className="py-1 text-red-300" disabled={busy} onClick={() => saveRemote(true)}>
                清除
              </Button>
            )}
            <Button type="button" variant="ghost" className="ml-auto py-1" onClick={() => setEditingRemote(false)}>
              取消
            </Button>
            <Button variant="primary" className="py-1" disabled={busy || !host.trim()} onClick={() => saveRemote()}>
              保存
            </Button>
          </div>
        </div>
      )}
      {resetting && (
        <form onSubmit={reset} className="space-y-2 pl-11">
          <PasswordInput value={password} onChange={setPassword} autoFocus />
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">重置后它的所有设备都会退出登录</span>
            <Button type="button" variant="ghost" className="ml-auto py-1" onClick={() => setResetting(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" className="py-1" disabled={busy || !password}>
              重置
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="pl-11">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </li>
  );
}

/** Admins: add accounts (there is no sign-up), reset passwords, grant admin, delete accounts. */
export function AccountsDialog({ me, onClose }: { me: User; onClose: () => void }) {
  const [list, setList] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  useEffect(() => {
    api.accounts().then(setList, (e: Error) => setError(e.message));
  }, []);

  return (
    <Modal title="账号管理" onClose={onClose}>
      <AddAccount
        onAdded={(next, username, password) => {
          setList(next);
          setIssued({ username, password });
        }}
      />
      {issued && (
        <div className="border-b border-zinc-800 px-4 py-3">
          <Credentials {...issued} onDone={() => setIssued(null)} />
        </div>
      )}
      {error && (
        <div className="px-4 py-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {!list && !error && <div className="px-4 py-3 text-sm text-zinc-500">读取中…</div>}
      <ul className="divide-y divide-zinc-800">
        {list?.map((a) => (
          <AccountRow key={a.id} account={a} me={me} onChanged={setList} onPassword={(username, password) => setIssued({ username, password })} />
        ))}
      </ul>
      <div className="space-y-1 border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
        <p>每个账号只看得到自己的会话和推送通知。</p>
        <p>
          普通账号的 AI 只在它自己的电脑上工作：通过 SSH 执行命令、读写文件，在这台服务器上没有任何工具（没有本机命令行和文件读写，网页抓取也不能访问本机和内网），想在服务器上做事会被直接拒绝。它也不加载这台电脑的个人设置（CLAUDE.md、插件、MCP、claude.ai 连接器、Codex 的应用和记忆）。它的记忆放在服务器上的 工作区/用户名/AGENTS.md，Claude 和 Codex 共用，每个会话都会读到，并在需要时自己更新。
        </p>
        <p>管理员的 AI 直接在这台服务器上工作。本机历史、终端、重启服务和这里的账号管理也只有管理员能用。</p>
        <p className="text-amber-300/80">所有账号共用这台服务器的 Claude / Codex 登录和额度，也用这台服务器的 SSH 密钥连接各自的电脑。</p>
      </div>
    </Modal>
  );
}

/** Anyone: change their own password. Their other devices are signed out; this one stays. */
export function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError('两次输入的新密码不一致');
    setBusy(true);
    setError('');
    try {
      await api.changePassword(current, next, await pushEndpoint().catch(() => undefined));
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="修改密码" onClose={onClose}>
      {done ? (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <Icon name="check" /> 密码已修改。这台设备保持登录，其他设备需要用新密码重新登录。
          </div>
          <Button variant="primary" className="w-full" onClick={onClose}>
            好
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3 p-4">
          <label className="block space-y-1">
            <span className="text-sm text-zinc-400">当前密码</span>
            <input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-zinc-400">新密码</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="至少 8 位" className={input} />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-zinc-400">再输一次新密码</span>
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
          </label>
          <ErrorText>{error}</ErrorText>
          <Button variant="primary" type="submit" className="w-full" disabled={busy || !current || !next || !again}>
            {busy ? '修改中…' : '修改密码'}
          </Button>
        </form>
      )}
    </Modal>
  );
}

/** A member's account memory: what its Claude and Codex sessions load, and update themselves. Editable here. */
export function MemoryDialog({ onClose }: { onClose: () => void }) {
  const [memory, setMemory] = useState<{ path: string; content: string; updatedAt: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.memory().then(
      (m) => {
        if (!m.available) return setError('管理员账号没有账号记忆：它的 Claude 用的是这台电脑的 ~/.claude/CLAUDE.md');
        setMemory(m);
        setDraft(m.content);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const save = async () => {
    if (!memory) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.saveMemory(draft, memory.updatedAt);
      setMemory({ ...memory, content: draft, updatedAt: r.updatedAt });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="我的记忆" onClose={onClose} wide>
      <div className="flex h-full min-h-[60dvh] flex-col gap-2 p-4">
        <p className="text-xs text-zinc-500">
          Claude 和 Codex 的每个会话开始时都会读到这份记忆（比如你电脑上的环境、项目在哪个目录、你的习惯），学到值得长期记住的东西时会自己更新；你也可以在这里直接改。对 AI 说「记住……」就会记下来。
          {memory && <span className="font-mono"> {shortPath(memory.path)}</span>}
        </p>
        {memory && (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-0 w-full flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-sm leading-relaxed outline-none focus:border-emerald-500"
          />
        )}
        <ErrorText>{error}</ErrorText>
        {memory && (
          <div className="flex items-center gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <Icon name="check" /> 已保存，之后开始的会话会用新的记忆
              </span>
            )}
            <Button variant="ghost" className="ml-auto" onClick={onClose}>
              关闭
            </Button>
            <Button variant="primary" onClick={save} disabled={busy || draft === memory.content}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
