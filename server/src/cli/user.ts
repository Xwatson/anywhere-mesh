// Account management from the terminal: npm run user -- list | add | passwd | admin | unadmin | del
// Deliberately does not load the advisor module, so it is safe to run while the service is up.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ensureHome, folderExists, homePathOf, setRemote } from '../accounts.js';
import { validHost, validPort } from '../remote/ssh.js';
import { adminCount, createUser, deleteUser, findUser, passwordProblem, setAdmin, setPassword, usernameProblem } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { dropDevices } from '../push.js';
import { deleteUploads } from '../uploads.js';

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    rlAny._writeToOutput = (s: string) => {
      if (!muted || s.includes('\n')) process.stdout.write(muted ? '\n' : s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function askNewPassword(): Promise<string> {
  const pw = await askHidden('密码: ');
  const problem = passwordProblem(pw);
  if (problem) throw new Error(problem);
  const again = await askHidden('再次输入密码: ');
  if (pw !== again) throw new Error('两次输入不一致');
  return pw;
}

const USAGE = `用法:
  npm run user -- list
  npm run user -- add <用户名> [--admin] [--adopt-folder]
  npm run user -- passwd <用户名>
  npm run user -- admin <用户名>      设为管理员
  npm run user -- unadmin <用户名> [--adopt-folder]    取消管理员
  npm run user -- remote <用户名> <用户@地址> [端口]   设置这个账号的电脑（AI 只在那台电脑上工作）
  npm run user -- remote <用户名> --clear
  npm run user -- del <用户名>
平时在网页的「账号管理」里操作即可（管理员可见），这里用于还没有账号或忘记密码的时候。
非管理员只在自己的电脑上工作（用 remote 设置，AI 通过 SSH 操作它），记忆放在「工作区/用户名」文件夹里；这个文件夹已经存在时，要加 --adopt-folder 确认让它使用。`;

function mustFind(name: string | undefined) {
  if (!name) throw new Error(USAGE);
  const user = findUser(name);
  if (!user) throw new Error(`用户 ${name} 不存在`);
  return user;
}

async function main() {
  const [cmd, name, ...flags] = process.argv.slice(2);
  switch (cmd) {
    case 'add': {
      if (!name) throw new Error(USAGE);
      const problem = usernameProblem(name);
      if (problem) throw new Error(problem);
      // The very first account is the admin either way.
      const admin = flags.includes('--admin') || adminCount() === 0;
      if (!admin && folderExists(name) && !flags.includes('--adopt-folder')) {
        throw new Error(`工作区里已经有 ${homePathOf(name)}，这个账号会使用它并能看到、修改里面的内容。确认的话加 --adopt-folder`);
      }
      const user = createUser(name, await askNewPassword(), admin);
      const home = ensureHome(user);
      console.log(`已创建用户 ${user.username}${user.isAdmin ? '（管理员）' : `，记忆在 ${home}/AGENTS.md。用 npm run user -- remote ${user.username} <用户@地址> 设置它的电脑`}`);
      break;
    }
    case 'passwd': {
      const user = mustFind(name);
      setPassword(user.id, await askNewPassword());
      dropDevices(user.id);
      console.log(`已更新 ${user.username} 的密码，旧登录已失效`);
      break;
    }
    case 'admin':
    case 'unadmin': {
      const user = mustFind(name);
      if (cmd === 'unadmin' && user.isAdmin && adminCount() <= 1) throw new Error('至少要保留一个管理员');
      if (cmd === 'unadmin' && user.isAdmin && folderExists(user.username) && !flags.includes('--adopt-folder')) {
        throw new Error(`工作区里已经有 ${homePathOf(user.username)}，取消管理员后这个账号会用它存放记忆。确认的话加 --adopt-folder`);
      }
      setAdmin(user.id, cmd === 'admin');
      if (cmd === 'unadmin') ensureHome({ ...user, isAdmin: false });
      console.log(cmd === 'admin' ? `${user.username} 现在是管理员` : `${user.username} 不再是管理员，只能在自己的电脑上工作（用 remote 设置）`);
      console.log('服务正在运行的话，请重启服务，让这个账号的会话按新身份运行');
      break;
    }
    case 'remote': {
      const user = mustFind(name);
      const [host, port] = flags;
      if (host === '--clear') {
        setRemote(user.id, null);
        console.log(`已清除 ${user.username} 的电脑，它暂时不能工作`);
      } else {
        const p = port ? Number(port) : null;
        if (!host || !validHost(host) || !validPort(p)) throw new Error('用法: npm run user -- remote <用户名> <用户@地址> [端口]');
        setRemote(user.id, { host, port: p });
        console.log(`${user.username} 的电脑设为 ${host}${p ? ` 端口 ${p}` : ''}`);
      }
      console.log('服务正在运行的话，这个账号已经打开的会话下一条消息起才用新的电脑（或者重启服务）');
      break;
    }
    case 'del': {
      const user = mustFind(name);
      if (user.isAdmin && adminCount() <= 1) throw new Error('至少要保留一个管理员');
      const ids = (db.prepare('SELECT id FROM chat_sessions WHERE user_id = ?').all(user.id) as { id: string }[]).map((r) => r.id);
      deleteUser(user.id);
      for (const id of ids) deleteUploads(id);
      rmSync(join(config.dataDir, 'advisors', `u${user.id}`), { recursive: true, force: true });
      console.log(`已删除用户 ${user.username} 和它的 ${ids.length} 个会话${user.isAdmin ? '' : `；文件夹 ${homePathOf(user.username)} 保留在磁盘上`}`);
      break;
    }
    case 'list': {
      const rows = db.prepare('SELECT username, is_admin, created_at, remote_host, remote_port FROM users ORDER BY id').all() as {
        username: string;
        is_admin: number;
        created_at: number;
        remote_host: string | null;
        remote_port: number | null;
      }[];
      for (const r of rows) {
        console.log(`${r.username}\t${r.is_admin ? '管理员' : `成员，电脑 ${r.remote_host ?? '（未设置）'}${r.remote_port ? `:${r.remote_port}` : ''}`}\t${new Date(r.created_at).toLocaleString()}`);
      }
      if (!rows.length) console.log('(无用户)');
      break;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
