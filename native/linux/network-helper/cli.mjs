#!/usr/bin/env node
import { NetworkClient } from './client.mjs';

const [command, path] = process.argv.slice(2);
if (!['status', 'hold'].includes(command) || !path?.startsWith('/')) {
  console.error('Usage: node cli.mjs status|hold /run/anywhere-network/cn.sock');
  process.exit(64);
}
const client = await NetworkClient.connect(path);
if (command === 'status') {
  try { console.log(JSON.stringify(await client.status())); }
  finally { await client.close(); }
} else {
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await client.close();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  client.on('disconnected', (reason) => {
    if (!closing) { console.error(reason); process.exitCode = 1; }
  });
  try {
    await client.acquire();
    console.log(JSON.stringify(await client.waitConnected()));
    // The connection and renewal timer keep the process alive. Closing a UI
    // window is not a release; the desktop main process must call close on quit.
  } catch (error) {
    await close();
    throw error;
  }
}
