import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { serveWorkspaceMcp } from './stdio.mjs';
export { createWorkspaceMcp } from './stdio.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (hostname() !== 'anywhere-crossborder-lab' || !existsSync('/etc/anywhere-crossborder-lab')) throw Error('LAB_GUEST_REQUIRED');
  await serveWorkspaceMcp(process.argv[2]);
}
