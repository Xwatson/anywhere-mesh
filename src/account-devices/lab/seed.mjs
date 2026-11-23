import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
if(hostname()!=='anywhere-crossborder-lab'||process.env.DATA_DIR!=='/srv/anywhere-lab/d3/host/auth')throw Error('LAB_GUEST_REQUIRED');
const {findUser,createUser,checkCredentials}=await import('../auth.mjs');
for(const u of JSON.parse(readFileSync(0,'utf8'))) {
  if(!findUser(u.username))createUser(u.username,u.password,u.username==='lab-admin');
  else if(!checkCredentials(u.username,u.password))throw Error('LAB_FIXTURE_LOGIN_CHANGED');
}
