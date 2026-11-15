import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { Journal } from '../execution/journal.mjs';
import { control } from '../execution/control.mjs';
import { exact, fail } from '../execution/protocol.mjs';
import { WorkspaceExecutor } from './executor.mjs';
import { LIFECYCLE } from './catalog.mjs';

export function createWorkspaceMcp(executor) {
  const server = new Server({ name: 'anywhere-workspace', version: '0.1.0' }, {
    capabilities: { tools: { listChanged: true } },
    instructions: 'Operate only on the bound workspace. Paths are relative. A running or cancelling task is not complete; poll its status. Never repeat an unknown operation. Permissions may change while connected.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await executor.capabilities()).tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (LIFECYCLE.some(t => t.name === name)) {
        const definition = LIFECYCLE.find(t => t.name === name); exact(args, Object.keys(definition.inputSchema.properties));
        if (name === 'workspace_task_status') return await executor.status(args.operationId);
        if (name === 'workspace_task_cancel') return await executor.cancel(args.operationId);
        const value = name === 'workspace_capabilities' ? await executor.capabilities() : await executor.output(args.operationId, args.afterSeq ?? 0);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      }
      const ticket = request.params._meta?.['anywhere/callTicket'];
      if (typeof ticket !== 'string') fail('CALL_TICKET_REQUIRED');
      return await executor.invoke(name, args, ticket, { signal: extra.signal });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.code ?? error.message }],
        structuredContent: { error: error.code ?? error.message,
          recovery: 'Use the same host call ticket to reconcile. An error response does not prove that execution did not occur.' } };
    }
  });
  let lastList;
  const timer = setInterval(async () => {
    try {
      const info = await executor.capabilities(), current = JSON.stringify([info.permission.version, info.bindingCurrent, info.connection]);
      if (lastList !== undefined && current !== lastList) await server.sendToolListChanged();
      lastList = current;
    } catch { /* Transport/state outage is returned by the next explicit request. */ }
  }, 1500);
  timer.unref();
  const close = server.close.bind(server);
  server.close = async () => { clearInterval(timer); await close(); };
  return server;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (hostname() !== 'anywhere-crossborder-lab' || !existsSync('/etc/anywhere-crossborder-lab')) throw new Error('LAB_GUEST_REQUIRED');
  const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const journal = new Journal(cfg.journalPath);
  const executor = new WorkspaceExecutor({ journal, binding: cfg.binding, control: (method, params) => control(cfg.brokerSocket, method, params) });
  const server = createWorkspaceMcp(executor);
  await server.connect(new StdioServerTransport());
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); journal.close(); process.exit(0); });
}
