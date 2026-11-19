import { serveWorkspaceMcp } from '../../workspace/stdio.mjs';

if (process.getuid() === 0) throw Error('SERVICE_USER_REQUIRED');
await serveWorkspaceMcp(process.argv[2]);
