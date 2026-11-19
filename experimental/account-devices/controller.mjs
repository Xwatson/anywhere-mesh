import { createInterface } from 'node:readline';
import { control } from '../execution/control.mjs';
import contract from './contract.cjs';
const slot=process.argv[2];if(!['a','b'].includes(slot))throw Error('INVALID_LAB_PROFILE');
const profile=process.argv[3]==='wan'?'wan':'d3';
const socket='/srv/anywhere-lab/'+profile+'/local/'+slot+'/control.sock';
const reply=v=>process.stdout.write(JSON.stringify(v)+'\n');
const input=createInterface({input:process.stdin});
input.on('line',async line=>{
  let id;
  try {
    if(line.length>24000)throw Error('INVALID_FRAME');
    const r=JSON.parse(line);id=r.id;contract.validate(r.method,r.params);
    reply({id,value:await control(socket,r.method,r.params)});
  } catch(e){reply({id,error:e.message});}
});
input.on('close',async()=>{await control(socket,'logout',{}).catch(()=>{});process.exit(0);});
reply({event:'ready'});
