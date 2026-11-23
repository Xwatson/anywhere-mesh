import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';

// DATA_DIR and CODEX_PATH are captured when the application config is imported.
const dir = await mkdtemp(join(tmpdir(), 'codex-rpc-test-'));
process.env.DATA_DIR = dir;
process.env.CODEX_PATH = join(dir, 'stdio');
const { CodexAppServer } = await import('../../session-host/codex-app-server.mjs');
test.after(() => rm(dir, { recursive: true, force: true }));

test('app-server still launches the configured CLI using the stable handshake', async t => {
  await writeFile(process.env.CODEX_PATH, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
  const m=JSON.parse(line);
  if(m.id!==undefined) console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{method:m.method}}));
});`, { mode: 0o700 });
  const client = new CodexAppServer();
  t.after(() => client.stop());
  assert.deepEqual(await client.call('thread/list', {}), { method: 'thread/list' });
});

test('attached transport opts in to dynamic tools and rejects pending calls at disconnect', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new CodexAppServer({ experimentalApi: true, transport: { input, output },
    onRequest: async (method, p) => ({ method, callId: p.callId }) });
  const wire = createInterface({ input: output });
  t.after(() => { client.stop(); wire.close(); input.destroy(); output.destroy(); });
  wire.on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') {
      assert.equal(m.params.capabilities.experimentalApi, true);
      input.write(JSON.stringify({id:m.id, result:{}}) + '\n');
    }
    if (m.method === 'thread/start') input.write(JSON.stringify({id:m.id, result:{thread:{id:'thread-a'}}}) + '\n');
  });
  assert.deepEqual(await client.call('thread/start', {}), {thread:{id:'thread-a'}});
  const response = once(wire, 'line');
  input.write(JSON.stringify({id:'from-server', method:'item/tool/call', params:{callId:'stable-id'}}) + '\n');
  const [line] = await response;
  assert.deepEqual(JSON.parse(line).result, {method:'item/tool/call',callId:'stable-id'});
  const waiting = client.call('turn/start', {});
  const rejected = assert.rejects(waiting, /已断开/);
  input.end();
  await rejected;
  assert.equal(client.running, false);
});
