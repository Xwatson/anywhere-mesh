import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';

const exec = promisify(execFile);
const run = async (...args) => (await exec(args[0], args.slice(1), { timeout: 15000 })).stdout.trim();
await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
const services = {}, helpers = {};
for (const role of ['agent', 'broker']) {
  const properties = await run('systemctl', 'show', '--property=ActiveState,MainPID', `anywhere-execution-${role}.service`);
  assert.match(properties, /MainPID=0/); assert.match(properties, /ActiveState=inactive/); services[role] = properties;
}
for (const role of ['cn', 'us']) {
  const c = await NetworkClient.connect(`/run/anywhere-network/${role}.sock`);
  helpers[role] = await c.status(); await c.close();
  assert.equal(helpers[role].phase, 'idle'); assert.equal(helpers[role].pid, null); assert.equal(helpers[role].interfacePresent, false);
  const qdisc = await run('docker', 'exec', `anywhere-helper-${role}-1`, 'tc', 'qdisc', 'show', 'dev', 'eth0');
  assert.doesNotMatch(qdisc, /netem/);
}
assert.equal(await run('docker', 'inspect', '-f', '{{.State.Running}}', 'anywhere-helper-us-mock-1'), 'true');
const baseline = JSON.parse(await run('docker', 'exec', 'anywhere-lab-cn-probe-1', 'python', '/probe/probe.py'));
assert.equal(baseline.ok, true);
const webStatus = (await fetch('http://127.0.0.1:3211/')).status; assert.equal(webStatus, 200);
const report = { timestamp: new Date().toISOString(), services, helpers, stage0Probe: baseline, labWebHttp: webStatus,
  restoredStageAMock: true, netemReset: true };
await writeFile('/srv/anywhere-lab/artifacts/execution-b-final-state.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
