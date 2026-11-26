import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fail } from '../execution/protocol.mjs';

// Optional stdio JSON-RPC adapter to delegate daily browser control to open-source
// @playwright/mcp or chrome-devtools-mcp while preserving AnywhereMesh's local permission gate.
export class ExternalBrowserMcp {
  constructor({ backend, httpEndpoint }) {
    this.backend = backend; // 'chrome-devtools-mcp' | 'playwright-mcp'
    this.httpEndpoint = httpEndpoint;
    this.child = null;
    this.rl = null;
    this.nextId = 0;
    this.pending = new Map();
    this.tools = [];
    this.readyPromise = null;
  }

  commandSpec() {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    if (this.backend === 'chrome-devtools-mcp') {
      return {
        command: process.env.ANYWHERE_CHROME_DEVTOOLS_MCP || npx,
        args: process.env.ANYWHERE_CHROME_DEVTOOLS_MCP
          ? ['--browserUrl', this.httpEndpoint]
          : ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', this.httpEndpoint],
      };
    }
    if (this.backend === 'playwright-mcp') {
      return {
        command: process.env.ANYWHERE_PLAYWRIGHT_MCP || npx,
        args: process.env.ANYWHERE_PLAYWRIGHT_MCP
          ? ['--cdp-endpoint', this.httpEndpoint]
          : ['-y', '@playwright/mcp@latest', '--cdp-endpoint', this.httpEndpoint],
      };
    }
    fail('INVALID_BROWSER_BACKEND');
  }

  async ensureStarted() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const { command, args } = this.commandSpec();
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
      this.child = child;
      let stderrTail = '';
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', line => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === undefined) return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(Error(msg.error.message || 'EXTERNAL_MCP_ERROR'));
        else entry.resolve(msg.result);
      });
      child.once('exit', () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(Error(`EXTERNAL_MCP_EXITED${stderrTail ? ': ' + stderrTail.trim().slice(-240) : ''}`));
        }
        this.pending.clear();
        this.readyPromise = null;
        this.child = null;
      });
      child.once('error', err => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        this.pending.clear();
        this.readyPromise = null;
        this.child = null;
      });
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'anywhere-mesh-browser', version: '0.5.0' },
      }, 25000);
      this.notify('notifications/initialized', {});
      const list = await this.request('tools/list', {}, 10000);
      this.tools = Array.isArray(list?.tools) ? list.tools : [];
      return this.tools;
    })().catch(err => {
      this.close();
      throw err;
    });
    return this.readyPromise;
  }

  notify(method, params) {
    if (this.child && !this.child.killed && this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
  }

  request(method, params, timeoutMs = 20000) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(Error('EXTERNAL_MCP_NOT_RUNNING'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`EXTERNAL_MCP_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  findTool(candidates) {
    for (const name of candidates) {
      const found = this.tools.find(t => t.name === name);
      if (found) return found.name;
    }
    return null;
  }

  async callMapped(tool, args) {
    await this.ensureStarted();
    const call = async (candidates, mappedArgs) => {
      const name = this.findTool(candidates);
      if (!name) fail('EXTERNAL_MCP_TOOL_UNSUPPORTED');
      return this.request('tools/call', { name, arguments: mappedArgs });
    };

    if (tool === 'browser_tabs') return call(['list_pages', 'browser_tabs'], this.backend === 'playwright-mcp' ? { action: 'list' } : {});
    if (tool === 'browser_snapshot') return call(['take_snapshot', 'browser_snapshot'], {});
    if (tool === 'browser_screenshot') return call(['take_screenshot', 'browser_take_screenshot'], { ...(args.fullPage ? { fullPage: true } : {}) });
    if (tool === 'browser_logs') {
      if (args.kind === 'network') return call(['list_network_requests', 'browser_network_requests'], {});
      return call(['list_console_messages', 'browser_console_messages'], {});
    }
    if (tool === 'browser_navigate') {
      const act = args.action ?? 'goto';
      if (act === 'back') return call(['navigate_page', 'browser_navigate_back'], this.backend === 'chrome-devtools-mcp' ? { type: 'back' } : {});
      if (act === 'forward') return call(['navigate_page', 'browser_navigate_forward'], this.backend === 'chrome-devtools-mcp' ? { type: 'forward' } : {});
      if (act === 'reload') return call(['navigate_page', 'browser_reload'], this.backend === 'chrome-devtools-mcp' ? { type: 'reload' } : {});
      return call(['navigate_page', 'browser_navigate'], this.backend === 'chrome-devtools-mcp' ? { type: 'url', url: args.url } : { url: args.url });
    }
    if (tool === 'browser_click') {
      const uid = args.ref;
      if (!uid) fail('EXTERNAL_MCP_REF_REQUIRED');
      return call(['click', 'browser_click'], this.backend === 'chrome-devtools-mcp' ? { uid, ...(args.doubleClick ? { dblClick: true } : {}) } : { ref: uid, element: uid });
    }
    if (tool === 'browser_type') {
      const uid = args.ref;
      if (!uid) fail('EXTERNAL_MCP_REF_REQUIRED');
      return call(['fill', 'browser_type'], this.backend === 'chrome-devtools-mcp'
        ? { uid, value: args.text }
        : { ref: uid, element: uid, text: args.text, ...(args.submit ? { submit: true } : {}) });
    }
    if (tool === 'browser_press') {
      return call(['press_key', 'browser_press_key'], { key: args.key });
    }
    if (tool === 'browser_eval') {
      return call(['evaluate_script', 'browser_evaluate'], { function: `() => (${args.expression})` });
    }
    if (tool === 'browser_wait') {
      if (args.text) return call(['wait_for', 'browser_wait_for'], this.backend === 'chrome-devtools-mcp' ? { text: args.text } : { text: args.text });
      await new Promise(r => setTimeout(r, Math.min(args.timeoutMs ?? 1000, 15000)));
      return { content: [{ type: 'text', text: 'Waited.' }] };
    }
    if (tool === 'browser_tab_action') {
      if (args.action === 'new') return call(['new_page', 'browser_tabs'], this.backend === 'playwright-mcp' ? { action: 'new' } : { url: args.url || 'about:blank' });
      if (args.action === 'close') return call(['close_page', 'browser_tabs'], this.backend === 'playwright-mcp' ? { action: 'close', index: Number(args.tabId) || 0 } : { pageIdx: Number(args.tabId) || 0 });
      return call(['select_page', 'browser_tabs'], this.backend === 'playwright-mcp' ? { action: 'select', index: Number(args.tabId) || 0 } : { pageIdx: Number(args.tabId) || 0 });
    }
    fail('EXTERNAL_MCP_TOOL_UNSUPPORTED');
  }

  close() {
    this.readyPromise = null;
    try { this.rl?.close(); } catch {}
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch {}
    }
    this.child = null;
  }
}
