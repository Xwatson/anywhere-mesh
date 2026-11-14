import { useState, type FormEvent } from 'react';
import { api, type User } from '../lib/api';
import { Button, ErrorText } from './ui';

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="space-y-1">
          <div className="font-mono text-emerald-400">&gt;_ anywhere coding</div>
          <p className="text-sm text-zinc-400">随时随地，用 Claude Code / Codex 写代码</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-zinc-400">用户名</span>
          <input
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 outline-none focus:border-emerald-500"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-zinc-400">密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 outline-none focus:border-emerald-500"
          />
        </label>
        <ErrorText>{error}</ErrorText>
        <Button variant="primary" type="submit" className="w-full py-2.5" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  );
}
