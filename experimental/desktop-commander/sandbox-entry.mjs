// Runs inside the mount/PID/user/network sandbox; no agent credentials are visible.
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
const cwd = realpathSync(path.join('/workspace', process.argv[2]));
if (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) throw new Error('CWD_ESCAPE');
process.chdir(cwd);
mkdirSync('/home/worker/.claude-server-commander', { recursive: true });
writeFileSync('/home/worker/.claude-server-commander/config.json', JSON.stringify({
  telemetryEnabled: false, allowedDirectories: ['/workspace'], defaultShell: '/bin/bash',
  blockedCommands: [], fileReadLineLimit: 200, fileWriteLineLimit: 200,
}));
process.argv.push('--no-onboarding');
await import('/opt/vendor/node_modules/@wonderwhy-er/desktop-commander/dist/index.js');
