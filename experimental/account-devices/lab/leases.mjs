import { NetworkClient } from '../../../native/linux/network-helper/client.mjs';
import { execFileSync } from 'node:child_process';
const leases=[];
async function stop() {
  for(const h of leases)await h.close().catch(()=>{});
}
let closing=false;
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{if(closing)return;closing=true;await stop();process.exit(0);});
try {
  for(const name of ['us','cn']){
    const c=await NetworkClient.connect('/run/anywhere-network/'+name+'.sock');
    leases.push(c);await c.acquire();
  }
  await Promise.all(leases.map(c=>c.waitConnected(20000)));
  execFileSync('/usr/bin/systemd-notify',['--ready']);
} catch(e) {await stop();throw e;}
