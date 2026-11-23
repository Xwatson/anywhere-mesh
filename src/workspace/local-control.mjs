import { randomUUID } from 'node:crypto';
import { control } from '../execution/control.mjs';
import { modes } from '../execution/grants.mjs';
import { readFileSync } from 'node:fs';

// The same local-device API can be consumed by the future desktop shell.
const [socket, action, value, expected] = process.argv.slice(2);
if (!socket || !['status', 'set-mode', 'review-preview', 'review-submit'].includes(action)) throw new Error('Usage: local-control.mjs SOCKET status | set-mode MODE EXPECTED_VERSION | review-preview OPERATION_ID | review-submit DECISION_JSON');
if (action === 'set-mode' && (!modes.includes(value) || !Number.isSafeInteger(Number(expected)))) throw new Error('A valid mode and observed permission version are required');
const method = { status: 'status', 'set-mode': 'setMode', 'review-preview': 'reviewPreview', 'review-submit': 'reviewUnknown' }[action];
const params = action === 'status' ? {} : action === 'set-mode' ? { requestId: randomUUID(), mode: value, expectedVersion: Number(expected) } :
  action === 'review-preview' ? { operationId: value } : JSON.parse(readFileSync(value, 'utf8'));
const response = await control(socket, method, params);
console.log(JSON.stringify(response, null, 2));
