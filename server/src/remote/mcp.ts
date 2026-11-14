// The only tools the AI of a remote account has (an MCP server over stdio, started by Claude Code
// or Codex for each session). Everything happens on the account's own computer over SSH; on this
// machine the tools only touch the account's memory file and the session's own attachments.
// Configured by one argument: base64 JSON { host, port, label, memoryFile, uploadsDir, controlDir }.
// Standalone (node built-ins and ./ssh only), so it runs as a plain child process.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, posix as posixPath, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { applyHunks, parsePatch } from './patch.js';
import { readRemoteFile, removeRemoteFile, runRemote, shareConnections, writeRemoteFile, type RemoteTarget } from './ssh.js';

interface Config extends RemoteTarget {
  /** How the computer is called in messages, e.g. "lxj 的电脑". */
  label: string;
  memoryFile: string;
  uploadsDir: string;
  /** Private folder for shared SSH connections (one handshake per session instead of one per call). */
  controlDir?: string;
  /** The session's project folder on the remote computer: where `run` starts. */
  startCwd?: string | null;
}

const cfg = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as Config & { sshOpts?: string };
if (cfg.sshOpts) process.env.ANYWHERE_SSH_OPTS = cfg.sshOpts;
const target: RemoteTarget = { host: cfg.host, port: cfg.port };
if (cfg.controlDir) {
  mkdirSync(cfg.controlDir, { recursive: true, mode: 0o700 });
  shareConnections(cfg.controlDir);
}

// ---- the remote shell: like a terminal, `run` keeps its working directory from call to call ----

/** Whether the remote shell understands what follows the working directory (bash, zsh, sh: yes; Windows: no). */
let posixShell: boolean | null = null;
/** Where the last `run` ended (POSIX shells; at first the session's project); relative paths of the file tools start here too. */
let cwd: string | null = cfg.startCwd || null;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function isPosix(): Promise<boolean> {
  if (posixShell !== null) return posixShell;
  const r = await runRemote(target, "trap 'printf __ac_trap__' EXIT; cd . 2>/dev/null || exit 1; printf __ac_posix__", { timeoutMs: 30_000 });
  if (r.code === 255 && !r.stdout) throw new Error(`SSH 连接失败，${cfg.label}可能不在线或拒绝了连接：${r.stderr.trim().slice(0, 300)}`);
  posixShell = r.stdout.includes('__ac_posix__') && r.stdout.includes('__ac_trap__');
  return posixShell;
}

/** A path as the file tools take it: relative paths start where `run` is (else the home folder). */
function remotePath(p: string): string {
  if (!cwd || /^([/\\~]|[A-Za-z]:)/.test(p)) return p;
  return posixPath.join(cwd, p);
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };
const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) });

/** What the model gets back from one stream: the start and the end of long output. */
function clip(s: string, max = 30_000): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max / 3));
  const tail = s.slice(-Math.floor((max * 2) / 3));
  return `${head}\n… [中间省略 ${s.length - head.length - tail.length} 个字符] …\n${tail}`;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** File contents as the model reads them: numbered lines, images as images, binary refused. */
function asContent(name: string, data: Buffer, offset = 1, limit = 2000): Result {
  const mime = IMAGE_TYPES[extname(name).toLowerCase()];
  if (mime) {
    if (data.length > 5 * 1024 * 1024) return text(`图片太大（${data.length} 字节），看不了`, true);
    return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
  }
  if (data.subarray(0, 8192).includes(0)) return text(`这是二进制文件（${data.length} 字节），不能按文本读取`, true);
  const lines = data.toString('utf8').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  if (!data.length) return text('（空文件）');
  const start = Math.max(1, Math.floor(offset));
  const slice = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit)));
  const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n');
  const more = start - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行，用 offset / limit 读后面的部分）` : '';
  return text(clip(body, 100_000) + more);
}

/** Replaces `old` by `new` in `content`: exactly once unless `all`. Tolerates CRLF files. */
function replaceIn(content: string, oldS: string, newS: string, all: boolean): string {
  if (!oldS) throw new Error('old_string 不能为空');
  if (oldS === newS) throw new Error('old_string 和 new_string 一样，没有要改的');
  let o = oldS;
  let n = newS;
  if (!content.includes(o) && content.includes('\r\n') && o.includes('\n')) {
    o = o.replace(/\r?\n/g, '\r\n');
    n = n.replace(/\r?\n/g, '\r\n');
  }
  const count = content.split(o).length - 1;
  if (count === 0) throw new Error('没有找到 old_string（要和文件内容逐字一致，包括缩进）');
  if (count > 1 && !all) throw new Error(`old_string 出现了 ${count} 次：再多带一些上下文让它唯一，或者设 replace_all`);
  return all ? content.split(o).join(n) : content.replace(o, () => n);
}

/** An attachment of this session: by its path, its stored name or its original name; never anything else. */
function attachment(file: string): string {
  const dir = existsSync(cfg.uploadsDir) ? realpathSync(cfg.uploadsDir) : cfg.uploadsDir;
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const want = basename(String(file));
  const hit = names.find((n) => n === want) ?? names.find((n) => n.replace(/^[0-9a-f]{8}-/, '') === want);
  if (!hit) throw new Error(`这个会话里没有叫「${want}」的附件${names.length ? `；有：${names.map((n) => n.replace(/^[0-9a-f]{8}-/, '')).join('、')}` : ''}`);
  const path = realpathSync(join(dir, hit));
  if (!path.startsWith(dir + sep)) throw new Error('附件路径无效');
  return path;
}

/** A PDF's text (pdftotext, from poppler), page breaks kept as form feeds turned into markers. */
function pdfText(path: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.split('\f').map((p, i, all) => (i < all.length - 1 || p.trim() ? `${i ? `\n—— 第 ${i + 1} 页 ——\n` : ''}${p}` : '')).join('')),
    ),
  );
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, name: string) => {
  if (typeof v !== 'string') throw new Error(`缺少参数 ${name}`);
  return v;
};

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: object;
  run(a: Record<string, unknown>): Promise<Result>;
}

const where = cfg.label;

const TOOLS: Tool[] = [
  {
    name: 'run',
    description:
      `在${where}上执行命令（通过 SSH，用那台电脑上用户的默认 shell）。和终端一样，cd 之后的工作目录会保留到下一次调用（Windows 电脑除外：每次从主目录开始）；` +
      '不是交互式终端，也不加载 ~/.zshrc 之类的登录配置（需要 nvm 等时用 zsh -lic "…" 或 bash -lc "…"）。stdin 参数的内容会作为命令的标准输入。' +
      '开发服务器、watch 这类不会自己结束的命令，设 run_in_background，会在后台启动并返回日志文件，之后用 run 查看日志。返回退出码、标准输出和标准错误。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时（毫秒），默认 120000，最长 1800000' },
        stdin: { type: 'string', description: '可选，作为标准输入传给命令的内容' },
        run_in_background: { type: 'boolean', description: '可选，在后台运行（不等它结束），输出写进日志文件' },
        description: { type: 'string', description: '可选，一句话说明这条命令做什么' },
      },
      required: ['command'],
    },
    async run(a) {
      const command = str(a.command, 'command');
      const timeoutMs = Math.min(Math.max(num(a.timeout, 120_000), 1000), 1_800_000);
      const stdin = typeof a.stdin === 'string' ? a.stdin : undefined;
      const posix = await isPosix();
      if (a.run_in_background === true) {
        if (!posix) return text('这台电脑不是 Linux / macOS，不支持 run_in_background。可以用 start 或 Start-Process 自己在后台启动', true);
        const log = `/tmp/anywhere-${randomBytes(4).toString('hex')}.log`;
        const script = `${cwd ? `cd ${shq(cwd)} 2>/dev/null; ` : ''}nohup "\${SHELL:-sh}" -c ${shq(command)} > ${log} 2>&1 < /dev/null & echo "$!"`;
        const r = await runRemote(target, script, { timeoutMs: 30_000 });
        if (r.code !== 0) return text(`没能在后台启动：${(r.stderr || r.stdout).trim()}`, true);
        const pid = r.stdout.trim();
        return text(`已在后台启动（PID ${pid}），输出写进 ${log}。用 run 执行 tail -n 50 ${log} 查看，kill ${pid} 停止。`);
      }
      // POSIX shells: start where the last call ended, and report where this one ends (an EXIT trap also fires on `exit`).
      const mark = `__ac_cwd_${randomBytes(4).toString('hex')}__`;
      const script = posix
        ? `${cwd ? `cd ${shq(cwd)} 2>/dev/null || printf '%s\\n' ${shq(`（原来的工作目录 ${cwd} 已经不在了，回到了主目录）`)} >&2\n` : ''}trap 'printf "\\n${mark}%s\\n" "$PWD"' EXIT\n${command}`
        : command;
      const r = await runRemote(target, script, { stdin, timeoutMs });
      let stdout = r.stdout;
      const at = stdout.lastIndexOf(`\n${mark}`);
      const before = cwd;
      if (at >= 0) {
        cwd = stdout.slice(at + mark.length + 1).split('\n')[0] || cwd;
        stdout = stdout.slice(0, at);
      }
      const parts = [r.timedOut ? `超时（${timeoutMs / 1000} 秒），已中止` : `退出码：${r.code ?? '无（连接失败）'}`];
      if (!r.timedOut && r.code === 255 && !stdout) parts.push(`SSH 连接失败，${where}可能不在线或拒绝了连接`);
      if (cwd !== before && cwd) parts.push(`（工作目录现在是 ${cwd}）`);
      if (stdout) parts.push(`--- 标准输出 ---\n${clip(stdout)}`);
      if (r.stderr) parts.push(`--- 标准错误 ---\n${clip(r.stderr, 10_000)}`);
      return text(parts.join('\n'), r.timedOut || r.code !== 0);
    },
  },
  {
    name: 'read_file',
    description: `读取${where}上的文件，返回带行号的内容（图片直接显示）。路径是那台电脑上的路径，相对路径从 run 当前的工作目录算（还没 cd 过就是主目录）。大文件用 offset（起始行，从 1 开始）和 limit（行数，默认 2000）分段读。`,
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['file_path'],
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const path = remotePath(str(a.file_path, 'file_path'));
      return asContent(path, await readRemoteFile(target, path), num(a.offset, 1), num(a.limit, 2000));
    },
  },
  {
    name: 'write_file',
    description: `在${where}上写文件（整个覆盖；不存在就新建，缺的文件夹会自动建）。改已有文件的一部分请用 edit_file 或 apply_patch。`,
    inputSchema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
    async run(a) {
      const path = remotePath(str(a.file_path, 'file_path'));
      const content = str(a.content, 'content');
      await writeRemoteFile(target, path, content);
      return text(`已写入 ${path}（${Buffer.byteLength(content)} 字节）`);
    },
  },
  {
    name: 'edit_file',
    description: `修改${where}上的文件：把 old_string 换成 new_string。old_string 要和文件内容逐字一致（包括缩进），并且只出现一次；要全部替换就设 replace_all。`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async run(a) {
      const path = remotePath(str(a.file_path, 'file_path'));
      const before = (await readRemoteFile(target, path)).toString('utf8');
      const after = replaceIn(before, str(a.old_string, 'old_string'), str(a.new_string, 'new_string'), a.replace_all === true);
      await writeRemoteFile(target, path, after);
      return text(`已修改 ${path}`);
    },
  },
  {
    name: 'apply_patch',
    description:
      `用 Codex 的补丁格式一次修改${where}上的一个或多个文件（新建、修改、删除、改名），和 Codex 自带的 apply_patch 格式完全一样：\n` +
      '*** Begin Patch\n*** Update File: 路径\n@@ 可选：改动上方附近的一行\n 不变的上下文行（以空格开头）\n-删掉的行\n+加上的行\n*** Add File: 路径\n+新文件的每一行\n*** Delete File: 路径\n*** End Patch\n' +
      '路径相对 run 当前的工作目录。上下文要和文件内容对上（空白差异可以容忍）；有一处对不上，整个补丁都不会生效。',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'string', description: '完整的补丁文本，从 *** Begin Patch 到 *** End Patch' } },
      required: ['patch'],
    },
    async run(a) {
      const ops = parsePatch(str(a.patch, 'patch'));
      // Everything is worked out before anything is written: a hunk that does not fit leaves every file as it was.
      const writes: { path: string; content: string }[] = [];
      const removes: string[] = [];
      const done: string[] = [];
      for (const op of ops) {
        const path = remotePath(op.path);
        if (op.kind === 'add') {
          writes.push({ path, content: op.lines.length ? `${op.lines.join('\n')}\n` : '' });
          done.push(`新建 ${op.path}`);
        } else if (op.kind === 'delete') {
          removes.push(path);
          done.push(`删除 ${op.path}`);
        } else {
          const data = await readRemoteFile(target, path);
          if (data.subarray(0, 8192).includes(0)) throw new Error(`${op.path} 是二进制文件，不能打补丁`);
          const after = op.hunks.length ? applyHunks(data.toString('utf8'), op.hunks, op.path) : data.toString('utf8');
          const dest = op.moveTo ? remotePath(op.moveTo) : path;
          writes.push({ path: dest, content: after });
          if (dest !== path) removes.push(path);
          done.push(op.moveTo ? `修改并改名 ${op.path} → ${op.moveTo}` : `修改 ${op.path}`);
        }
      }
      for (const w of writes) await writeRemoteFile(target, w.path, w.content);
      for (const r of removes) await removeRemoteFile(target, r);
      return text(`补丁已应用：${done.join('，')}`);
    },
  },
  {
    name: 'read_attachment',
    description:
      '读取用户在网页上为这个会话上传的附件：文本、代码、日志带行号，PDF 读出文字，图片直接显示。file 是附件名或消息里给出的附件路径。压缩包、Word、Excel 等请用 send_attachment 传到他电脑上再处理。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file'] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const path = attachment(str(a.file, 'file'));
      if (statSync(path).size > 20 * 1024 * 1024) return text('附件太大，请用 send_attachment 传到电脑上再处理', true);
      if (extname(path).toLowerCase() === '.pdf') {
        const body = await pdfText(path).catch(() => null);
        if (body === null) return text('读不出这个 PDF 的文字，可以用 send_attachment 传到他的电脑上再处理', true);
        if (!body.trim()) return text('这个 PDF 里没有可以提取的文字（可能是扫描件）。在 Claude 会话里，50 页以内的 PDF 会直接附在消息里给你看', true);
        return asContent(`${path}.txt`, Buffer.from(body), num(a.offset, 1), num(a.limit, 2000));
      }
      const data = readFileSync(path);
      if (data.subarray(0, 8192).includes(0) && !IMAGE_TYPES[extname(path).toLowerCase()]) {
        return text(`这是二进制文件（${data.length} 字节），不能直接读。用 send_attachment 传到他的电脑上，在那边用合适的工具打开（比如 unzip、python）`, true);
      }
      return asContent(path, data, num(a.offset, 1), num(a.limit, 2000));
    },
  },
  {
    name: 'send_attachment',
    description: `把用户在网页上传的附件传到${where}上。remote_path 是目标路径（以 / 结尾表示放进这个文件夹，用原来的文件名）。`,
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, remote_path: { type: 'string' } }, required: ['file', 'remote_path'] },
    async run(a) {
      const path = attachment(str(a.file, 'file'));
      let dest = remotePath(str(a.remote_path, 'remote_path'));
      if (/[/\\]$/.test(dest)) dest += basename(path).replace(/^[0-9a-f]{8}-/, '');
      await writeRemoteFile(target, dest, { localFile: path });
      return text(`已传到 ${dest}`);
    },
  },
  {
    name: 'memory_edit',
    description: '修改这个账号的长期记忆（每个会话开始时都会读到）：把 old_string 换成 new_string，old_string 要逐字一致且唯一。old_string 为空表示把 new_string 追加到末尾。',
    inputSchema: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['new_string'] },
    async run(a) {
      const cur = existsSync(cfg.memoryFile) ? readFileSync(cfg.memoryFile, 'utf8') : '';
      const oldS = typeof a.old_string === 'string' ? a.old_string : '';
      const newS = str(a.new_string, 'new_string');
      const next = oldS ? replaceIn(cur, oldS, newS, false) : `${cur.replace(/\n*$/, '\n')}${newS}\n`;
      if (next.length > 200_000) return text('记忆太长了，请先用 memory_write 整理精简', true);
      writeFileSync(cfg.memoryFile, next);
      return text('记忆已更新');
    },
  },
  {
    name: 'memory_write',
    description: '整个重写这个账号的长期记忆（用于整理、精简；会覆盖原内容，别丢掉还有用的条目）。',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    async run(a) {
      const content = str(a.content, 'content');
      if (!content.trim()) return text('内容为空，没有写入', true);
      if (content.length > 200_000) return text('记忆太长了，请精简', true);
      writeFileSync(cfg.memoryFile, content.endsWith('\n') ? content : `${content}\n`);
      return text('记忆已重写');
    },
  },
];

// ---- MCP over stdio: newline-delimited JSON-RPC 2.0 ----

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg: { id?: string | number; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params } = msg;
  if (id === undefined || !method) return; // notifications (initialized, cancelled) and stray responses
  try {
    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'remote', version: '1.0.0' },
          },
        });
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations && { annotations }) })) } });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return send({ id, result: text(`没有这个工具：${String(params?.name)}`, true) });
        const result = await tool.run((params?.arguments ?? {}) as Record<string, unknown>).catch((e: Error) => text(e.message, true));
        return send({ id, result });
      }
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ id, error: { code: -32603, message: (e as Error).message } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg: Parameters<typeof handle>[0];
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void handle(msg);
});
process.stdin.on('end', () => process.exit(0));
