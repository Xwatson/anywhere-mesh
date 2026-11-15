import { randomUUID } from 'node:crypto';
import { control } from '../execution/control.mjs';
import { modes } from '../execution/grants.mjs';

// The same local-device API can be consumed by the future desktop shell.
const [socket, action, value, expected] = process.argv.slice(2);
if (!socket || !['status', 'set-mode'].includes(action)) throw new Error('Usage: local-control.mjs SOCKET status | set-mode MODE EXPECTED_VERSION');
if (action === 'set-mode' && (!modes.includes(value) || !Number.isSafeInteger(Number(expected)))) throw new Error('A valid mode and observed permission version are required');
const response = await control(socket, action === 'status' ? 'status' : 'setMode', action === 'status' ? {} : {
  requestId: randomUUID(), mode: value, expectedVersion: Number(expected),
});
console.log(JSON.stringify(response, null, 2));
