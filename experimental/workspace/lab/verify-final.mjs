import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';

const exec = promisify(execFile);
const run = async (...a) => (await exec(a[0], a.slice(1), { timeout: 15000 })).stdout.trim();
await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
const services = {}, helpers = {};
for (const prefix of ['anywhere-execution', 'anywhere-dc', 'anywhere-workspace']) for (const role of ['agent', 'broker']) {
  const unit = `${prefix}-${role}.service`;
  services[unit] = await run('systemctl', 'show', '--property=ActiveState,MainPID,UnitFileState', unit);
  assert.match(services[unit], /MainPID=0/); assert.match(services[unit], /ActiveState=inactive/);
  assert.doesNotMatch(services[unit], /UnitFileState=enabled/);
}
for (const side of ['cn', 'us']) {
  const client = await NetworkClient.connect(`/run/anywhere-network/${side}.sock`);
  try { helpers[side] = await client.status(); } finally { await client.close(); }
  assert.equal(helpers[side].phase, 'idle'); assert.equal(helpers[side].pid, null);
  assert.equal(helpers[side].interfacePresent, false);
  assert.doesNotMatch(await run('docker', 'exec', `anywhere-helper-${side}-1`, 'tc', 'qdisc', 'show', 'dev', 'eth0'), /netem/);
}
assert.equal(await run('docker', 'inspect', '-f', '{{.State.Running}}', 'anywhere-helper-us-mock-1'), 'true');
assert.equal(await run('docker', 'inspect', '-f', '{{.State.Running}}', 'anywhere-helper-relay-1'), 'true');
const stage0 = JSON.parse(await run('docker', 'exec', 'anywhere-lab-cn-probe-1', 'python', '/probe/probe.py'));
assert.equal(stage0.ok, true);
const web = (await fetch('http://127.0.0.1:3211/')).status; assert.equal(web, 200);
const bwrapPermissions = await run('stat', '-c', '%U:%G %a', '/usr/lib/anywhere-dc/bwrap');
assert.equal(bwrapPermissions, 'root:anywhere-exec-agent 750');
const patches = JSON.parse(await readFile('/srv/anywhere-lab/desktop-c/vendor-patches.json', 'utf8'));
for (const p of patches) {
  const data = await readFile(`/srv/anywhere-lab/vendor/desktop-commander-0.3.3/node_modules/@wonderwhy-er/desktop-commander/${p.path}`);
  assert.equal(createHash('sha256').update(data).digest('hex'), p.afterSha256);
}
// Read only the permission and task summaries. Never export facade call tickets.
const persisted = JSON.parse(await run('sudo', '-n', 'python3', '-c', `import json,sqlite3
b='/srv/anywhere-lab/workspace-b2/'
a=sqlite3.connect('file:'+b+'agent/journal.sqlite?mode=ro',uri=True)
grant=json.loads(a.execute("select value from records where bucket='meta' and key='workspaceGrant'").fetchone()[0])
c=sqlite3.connect('file:'+b+'broker/journal.sqlite?mode=ro',uri=True)
ops=[json.loads(r[0]) for r in c.execute("select value from records where bucket='ops'")]
print(json.dumps(dict(permission=grant,operationCount=len(ops),unknown=[dict(operationId=o['operationId'],reason=o['reason'],starts=o['starts']) for o in ops if o['state']=='unknown'])))
`));
assert.equal(persisted.permission.mode, 'revoked'); assert.equal(persisted.unknown.length, 1);
assert.equal(persisted.unknown[0].starts, 1);
const integration = JSON.parse(await readFile('/srv/anywhere-lab/artifacts/workspace-mcp-integration.json', 'utf8'));
assert.equal(integration.passed, true); assert.equal(integration.results.length, 12);
const report = { at: new Date().toISOString(), services, helpers, stage0, labWebHttp: web,
  restoredStageAMock: true, netemReset: true, realCli: false, patchedFiles: patches.length, bwrapPermissions, persisted };
await writeFile('/srv/anywhere-lab/artifacts/workspace-mcp-final-state.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
