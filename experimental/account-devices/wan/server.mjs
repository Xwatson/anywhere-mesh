import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.getuid() === 0) throw Error('SERVICE_USER_REQUIRED');
process.umask(0o077);
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!isAbsolute(config.stateDir) || process.env.DATA_DIR !== join(config.stateDir,'auth')) {
  throw Error('ISOLATED_AUTH_DATABASE_REQUIRED');
}
if (process.argv[3] === '--bootstrap') {
  const { userCount, createUser, usernameProblem, passwordProblem } = await import('../../../server/dist/auth.js');
  const { db } = await import('../../../server/dist/db.js');
  if (userCount() === 0) {
    const accounts = JSON.parse(readFileSync(0,'utf8'));
    if (!Array.isArray(accounts) || !accounts.some(a=>a.isAdmin===true)) throw Error('ADMIN_REQUIRED');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const a of accounts) {
        if (typeof a.username !== 'string' || typeof a.password !== 'string' || typeof a.isAdmin !== 'boolean' ||
            usernameProblem(a.username) || passwordProblem(a.password)) throw Error('INVALID_TEST_ACCOUNT');
        createUser(a.username,a.password,a.isAdmin);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
} else {
  const { startServer } = await import('../host.mjs');
  const app = await startServer({
    ...config,
    mcpPath: fileURLToPath(new URL('./mcp.mjs', import.meta.url)),
    antigravityMcpBridge: config.antigravityMcpBridge || fileURLToPath(new URL('./agy-mcp-bridge.mjs', import.meta.url)),
  });
  console.log('Remote test session host ready on '+config.host+':'+app.port);
  let closing = false;
  for (const sig of ['SIGINT','SIGTERM']) process.on(sig,async()=>{
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
