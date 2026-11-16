// VM-only mock US host plus local desktop control. No model/CLI credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Journal } from '../execution/journal.mjs';
import { control } from '../execution/control.mjs';
import { WorkspaceExecutor } from '../workspace/executor.mjs';
import { NetworkClient } from '../../native/linux/network-helper/client.mjs';
import { Client } from '../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import contract from './contract.cjs';

export const BASE = '/srv/anywhere-lab/desktop-d';
const RUNTIME = '/usr/lib/anywhere-desktop-runtime/experimental';
const exec = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
const run = async (...args) => (await exec(args[0], args.slice(1), { timeout: 20000, maxBuffer: 512 * 1024 })).stdout.trim();
const local = (method, params = {}) => control(`${BASE}/local/control.sock`, method, params);
const broker = (method, params = {}) => control(`${BASE}/broker/control.sock`, method, params);
const svc = (action, ...roles) => run('sudo', '-n', 'systemctl', action, ...roles.map(r => `anywhere-desktop-${r}.service`));
const textOf = r => r?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
const summary = j => ({ id: j.id, title: j.title, action: j.action, createdAt: j.createdAt, state: j.state,
  done: Boolean(j.done), consumed: Boolean(j.consumed), error: j.error, cancelRequested: Boolean(j.cancelRequested) });
export class DesktopController {
  constructor() {
    this.clients = new Map(); this.watching = new Set(); this.work = new Set(); this.queue = Promise.resolve();
    this.error = null; this.ready = false; this.closing = false;
  }
  async init() {
    await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
    this.tickets = new Journal(`${BASE}/facade/tickets.sqlite`);
    this.history = new Journal(`${BASE}/facade/history.sqlite`);
    try {
      await svc('start', 'agent');
      await this.until(async () => local('status'));
      // A fresh desktop process always starts with local authority revoked.
      await this.setPermission('revoked');
      this.ready = true;
      await this.remoteStart();
    } catch (e) { this.error = e.message; }
    this.timer = setInterval(() => this.track(this.refresh()), 800);
    return this.state();
  }
  async until(fn, ms = 6000) {
    const end = Date.now() + ms; let error;
    while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { error = e; } await sleep(150); }
    throw Error(error?.message ?? 'WAIT_TIMEOUT');
  }
  track(p) { this.work.add(p); p.catch(e => { this.error = e.message; }).finally(() => this.work.delete(p)); return p; }
  async remoteStart() {
    if (!this.us) {
      const h = await NetworkClient.connect('/run/anywhere-network/us.sock');
      try { await h.acquire(); this.us = h; } catch (e) { await h.close(); throw e; }
      h.on('disconnected', reason => { if (!this.closing && reason !== 'CLIENT_CLOSED') this.error = reason; });
    }
    if (!this.mockStopped) {
      // This is the existing laboratory fixture, not the production service.
      await run('docker', 'stop', '-t', '2', 'anywhere-helper-us-mock-1'); this.mockStopped = true;
    }
    await svc('start', 'broker');
    await this.until(async () => broker('workspace'));
  }
  async setPermission(mode) {
    const state = await local('status');
    if (state.grant.mode === mode) return { grant: state.grant };
    return local('setMode', { requestId: randomUUID(), expectedVersion: state.grant.grantVersion, mode });
  }
  request(method, params = {}) {
    contract.validate(method, params);
    if (this.closing) throw Error('DESKTOP_CLOSING');
    if (method === 'state') return this.state();
    if (method === 'task') return Promise.resolve(this.task(params.id));
    const task = this.queue.catch(() => {}).then(() => this.mutate(method, params));
    this.queue = task; return task;
  }
  async mutate(method, p) {
    if (method === 'permission') { await this.setPermission(p.mode); return this.state(); }
    if (method === 'connect') {
      await svc('start', 'agent'); this.ready = true; await this.remoteStart();
      if (!this.cn) {
        const h = await NetworkClient.connect('/run/anywhere-network/cn.sock');
        try { await h.acquire(); this.cn = h; } catch (e) { await h.close(); throw e; }
        h.on('disconnected', reason => { if (reason !== 'CLIENT_CLOSED') { this.cn = null; this.error = reason; } });
      }
      this.error = null; return this.state();
    }
    if (method === 'disconnect') { await this.disconnect(); return this.state(); }
    if (method === 'run') return this.startJob(p.action);
    const job = this.getJob(p.id);
    if (method === 'cancel') {
      if (!job.operationId || job.done) throw Error('TASK_NOT_RUNNING');
      const h = await this.host(job);
      await h.executor.cancel(job.operationId);
      const latest = this.getJob(job.id); latest.cancelRequested = true; this.save(latest); return this.task(job.id);
    }
    if (method === 'reviewPreview') {
      if (job.state !== 'unknown' || !job.operationId) throw Error('TASK_NOT_UNKNOWN');
      const preview = await local('reviewPreview', { operationId: job.operationId });
      return { id: job.id, title: job.title, command: job.args.command, path: job.args.path,
        starts: preview.starts, reason: preview.reason, digest: preview.expectedDigest, outcome: 'unknown' };
    }
    if (method === 'review') {
      if (job.state !== 'unknown') throw Error('TASK_NOT_UNKNOWN');
      if (job.review && (job.review.expectedDigest !== p.digest || job.review.note !== p.note.trim())) throw Error('REVIEW_DECISION_CONFLICT');
      job.review ??= { requestId: randomUUID(), operationId: job.operationId, expectedDigest: p.digest,
        disposition: 'acknowledge_unknown', note: p.note.trim() };
      this.save(job); // Preserve the same decision ID if the local reply is lost.
      try { await local('reviewUnknown', job.review); }
      catch (e) {
        if (e.message === 'REVIEW_STALE') { delete job.review; this.save(job); }
        throw e;
      }
      await this.refreshJob(job.id); return this.task(job.id);
    }
    throw Error('INVALID_DESKTOP_REQUEST');
  }
  getJob(id) { const job = this.history.get('jobs', id); if (!job) throw Error('TASK_NOT_FOUND'); return job; }
  save(job) { this.history.put('jobs', job.id, job); }
  task(id) { const j = this.getJob(id); return { ...summary(j), output: j.output ?? '', resultText: j.resultText ?? '',
    truncated: Boolean(j.truncated), outcome: j.outcome, command: j.args.command, path: j.args.path }; }
  async state() {
    const [l, b] = await Promise.allSettled([local('status'), broker('workspace')]);
    const device = l.status === 'fulfilled' ? l.value : null, remote = b.status === 'fulfilled' ? b.value : null;
    const synced = Boolean(device && remote?.confirmed && remote.grant.grantVersion === device.grant.grantVersion);
    return { version: 1, mockHost: true, workspace: { label: 'Linux 示例项目', path: `${BASE}/workspace` },
      connection: this.cn ? (remote?.confirmed ? 'connected' : 'connecting') : 'disconnected',
      permission: { mode: device?.grant.mode ?? 'revoked', localReady: Boolean(device), synced },
      blockers: remote?.blockers?.length ?? 0, error: this.error,
      tasks: (this.history?.all('jobs') ?? []).sort((a, b) => b.createdAt - a.createdAt).map(summary).slice(0, 50),
      active: (this.history?.all('jobs') ?? []).some(j => !j.done), history: this.history?.storage() };
  }
  async host(job) {
    if (this.clients.has(job.id)) return this.clients.get(job.id);
    const config = `${BASE}/facade/host-${job.id}.json`;
    await writeFile(config, JSON.stringify({ binding: job.binding, journalPath: `${BASE}/facade/tickets.sqlite`, brokerSocket: `${BASE}/broker/control.sock`, waitMs: 0 }), { mode: 0o600 });
    const client = new Client({ name: 'anywhere-desktop-mock-host', version: '0.1.0' });
    const transport = new StdioClientTransport({ command: '/usr/local/bin/node',
      args: [`${RUNTIME}/workspace/mcp.mjs`, config], stderr: 'pipe', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const connecting = client.connect(transport); transport.stderr?.resume();
    try { await connecting; } catch (e) { await client.close().catch(() => {}); throw e; }
    const host = { client, config, executor: new WorkspaceExecutor({ journal: this.tickets, binding: job.binding, control: broker }) };
    this.clients.set(job.id, host); return host;
  }
  async closeHost(id) {
    const h = this.clients.get(id); if (!h) return;
    this.clients.delete(id); await h.client.close().catch(() => {}); await unlink(h.config).catch(() => {});
  }
  async startJob(action) {
    if (this.history.all('jobs').some(j => !j.done)) throw Error('TASK_IN_PROGRESS_OR_NEEDS_REVIEW');
    const current = await this.state(); if (current.connection !== 'connected' || !current.permission.synced || current.blockers) throw Error('DEVICE_NOT_READY');
    const modes = { read: ['read', 'edit', 'execute'], edit: ['edit', 'execute'], build: ['execute'], long: ['execute'] };
    if (!modes[action].includes(current.permission.mode)) throw Error('PERMISSION_REQUIRED');
    let tool = 'workspace_run', args, title;
    if (action === 'read') { tool = 'workspace_read_file'; args = { path: 'notes.txt' }; title = '读取项目说明'; }
    if (action === 'edit') {
      const snapshot = this.history.get('desktop', 'fileSnapshot');
      if (!snapshot?.revision) throw Error('READ_FILE_BEFORE_EDIT');
      tool = 'workspace_write_file'; args = { path: 'notes.txt', content: `桌面编辑验证 ${new Date().toISOString()}\n`, mode: 'append', expectedRevision: snapshot.revision }; title = '追加项目记录';
    }
    if (action === 'build') { args = { command: 'node build.mjs && node --test test.mjs' }; title = '构建并运行测试'; }
    if (action === 'long') { args = { command: 'node long.mjs' }; title = '可取消的长任务'; }
    const g = (await broker('workspace')).grant;
    const binding = Object.fromEntries(['accountId', 'deviceId', 'workspaceId', 'grantVersion'].map(k => [k, g[k]]));
    Object.assign(binding, { sessionId: 'desktop-mock', turnId: randomUUID(), turnEpoch: 1 });
    this.history.ensureCapacity(512 * 1024);
    const job = { id: randomUUID(), title, action, tool, args, binding, createdAt: Date.now(), state: 'preparing', done: false, consumed: false };
    this.save(job);
    this.track(this.dispatchJob(job)); return { id: job.id };
  }
  async dispatchJob(job) {
    this.watching.add(job.id);
    try {
      const h = await this.host(job), ticket = await h.executor.issue(job.id, job.tool, job.args);
      job.operationId = ticket.operationId; job.state = 'prepared'; this.save(job);
      const result = await h.client.callTool({ name: job.tool, arguments: job.args, _meta: { 'anywhere/callTicket': ticket.ticket } }, undefined, { timeout: 25000 });
      await this.capture(this.getJob(job.id), h, result);
    } catch (e) { job = this.getJob(job.id); job.error = e.message; this.save(job); }
    finally { this.watching.delete(job.id); }
  }
  async refresh() {
    if (this.closing || !this.history) return;
    for (const job of this.history.all('jobs')) if (!job.consumed && !job.done || job.done && !job.consumed && job.operationId) await this.refreshJob(job.id);
  }
  async refreshJob(id) {
    if (this.watching.has(id)) return;
    this.watching.add(id);
    try {
      const job = this.getJob(id), h = await this.host(job);
      if (!job.operationId) {
        const found = await h.executor.recover(job.id); // Never issue/invoke on restart.
        if (!found) {
          job.state = 'interrupted'; job.done = true; job.error = '提交前中断，未自动重试'; this.save(job); await this.closeHost(id); return;
        }
        job.operationId = found.operationId; this.save(job);
      }
      const result = await h.client.callTool({ name: 'workspace_task_status', arguments: { operationId: job.operationId } });
      await this.capture(job, h, result);
    } catch (e) { const job = this.getJob(id); job.error = e.message; this.save(job); }
    finally { this.watching.delete(id); }
  }
  async capture(job, h, response) {
    const data = response?.structuredContent, task = data?.task;
    if (!task) throw Error(data?.error ?? 'INVALID_TASK_RESPONSE');
    job.state = task.state; job.cancelRequested = task.cancelRequested; job.error = null;
    job.outcome = data.result?.executionOutcome; job.resultText = textOf(response).slice(0, 32000);
    const pages = []; let cursor = 0;
    // Output and history remain bounded; every retained page is committed before ack.
    while (cursor < task.receivedSeq) {
      const page = await h.executor.output(job.operationId, cursor);
      if (page.nextSeq <= cursor) throw Error('OUTPUT_NO_PROGRESS');
      pages.push(page); cursor = page.nextSeq;
    }
    job.output = pages.flatMap(p => p.rows).map(r => r.data).join('').slice(-65536);
    job.truncated = pages.some(p => p.truncatedThrough > 0) || task.gaps?.length > 0;
    job.done = task.resultReady;
    if (task.resultReady) {
      const receiptId = `desktop-history:${job.id}`;
      // Durable receipt contains the result, not merely the renderer's display state.
      this.history.tx(() => {
        this.history.put('results', job.id, { receiptId, digest: task.resultDigest, response, pages });
        const version = data.result?.fileVersions?.find(f => f.path === 'notes.txt') ?? data.result?.fileVersions?.[0];
        if (task.state === 'succeeded' && version && ['read', 'edit'].includes(job.action)) this.history.put('desktop', 'fileSnapshot', version);
        this.save(job);
      });
      await h.executor.consumeAfterPersist({ operationId: job.operationId, resultDigest: task.resultDigest, receiptId });
      job.consumed = true; this.save(job); await this.closeHost(job.id);
      const finished = this.history.entries('jobs').filter(r => r.value.consumed || r.value.state === 'interrupted');
      this.history.tx(() => { for (const { key } of finished.slice(0, Math.max(0, finished.length - 50))) {
        this.history.archive('jobs', key); this.history.archive('results', key);
      } });
    } else this.save(job);
  }
  async disconnect() {
    await this.setPermission('revoked');
    // Revocation is local and durable even if the relay is already unavailable.
    // It also stops descendants; leave unknown outcomes for explicit local review.
    await this.until(async () => !(await local('status')).pendingCancellations.length, 9000).catch(e => { this.error = e.message; });
    if (this.cn) { const h = this.cn; this.cn = null; await h.close(); }
  }
  shutdown() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.closing = true; clearInterval(this.timer);
      await this.queue.catch(() => {});
      let failure;
      try { await this.disconnect(); } catch (e) { failure = e; }
      // Service stop is scoped to D and kills its entire command cgroup.
      await svc('stop', 'agent', 'broker').catch(e => { failure ??= e; });
      await Promise.allSettled([...this.work]);
      for (const id of [...this.clients.keys()]) await this.closeHost(id);
      for (const h of [this.cn, this.us]) if (h) await h.close().catch(e => { failure ??= e; });
      this.cn = this.us = null;
      if (this.mockStopped) await run('docker', 'start', 'anywhere-helper-us-mock-1').catch(e => { failure ??= e; });
      this.tickets?.close(); this.history?.close();
      if (failure) throw failure;
      return { stopped: true };
    })(); return this.stopping;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const controller = new DesktopController();
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const boot = controller.init(); boot.then(() => send({ event: 'ready' })).catch(e => send({ event: 'bootError', error: e.message }));
  const input = createInterface({ input: process.stdin, terminal: false }); let outstanding = 0;
  const stop = async () => { try { await boot.catch(() => {}); await controller.shutdown(); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } };
  input.on('line', async line => {
    let request, counted = false;
    try {
      if (line.length > 8192 || outstanding >= 16) throw Error('FRAME_LIMIT');
      request = JSON.parse(line);
      if (!Number.isSafeInteger(request.id) || request.id < 1 || Object.keys(request).some(k => !['id', 'method', 'params'].includes(k))) throw Error('INVALID_FRAME');
      contract.validate(request.method, request.params);
      outstanding++; counted = true; await boot; const value = await controller.request(request.method, request.params);
      send({ id: request.id, value });
    } catch (e) { send({ id: request?.id, error: e.message }); }
    finally { if (counted) outstanding--; }
  });
  input.on('close', stop); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
