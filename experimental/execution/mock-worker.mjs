import { appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.argv[2] === 'child') { setInterval(() => {}, 1000); }
else {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const { args, operationId, effectsPath } = JSON.parse(input);
  // Deliberate mock side effect, fsynced independently of the agent journal.
  // Crash tests prove that an unknown result never causes this to run again.
  const fd = openSync(effectsPath, 'a', 0o600);
  appendFileSync(fd, JSON.stringify({ operationId, pid: process.pid }) + '\n'); fsyncSync(fd); closeSync(fd);
  if (args.spawnChild) {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'child'], { stdio: 'ignore', env: {} });
    process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\n');
  }
  for (let i = 1; i <= args.steps; i++) {
    const stream = i % 2 ? process.stdout : process.stderr;
    const line = `${i}:` + 'x'.repeat(args.bytesPerStep) + '\n';
    if (!stream.write(line)) await new Promise((resolve) => stream.once('drain', resolve));
    await sleep(args.intervalMs);
  }
  process.exit(args.exitCode);
}
