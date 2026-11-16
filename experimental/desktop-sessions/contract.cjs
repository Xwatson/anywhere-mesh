'use strict';
const id=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(x);
const methods={state:[],connect:[],disconnect:[],chooseWorkspace:[],selectWorkspace:['workspaceId'],permission:['workspaceId','mode'],createSession:['workspaceId','title'],selectSession:['sessionId'],send:['sessionId','text'],stop:['sessionId','turnId'],history:['sessionId','beforeSeq'],retry:['requestId'],reviewPreview:['sessionId','turnId'],review:['sessionId','turnId','digest','note']};
function validate(method,params={},internal=false){
  const keys=internal&&method==='registerWorkspace'?['path']:methods[method];
  if(!keys||!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(params,k)))throw Error('INVALID_DESKTOP_REQUEST');
  for(const k of ['workspaceId','sessionId','turnId','requestId'])if(params[k]!==undefined&&!id(params[k]))throw Error('INVALID_ID');
  for(const [k,max] of [['title',80],['text',8192],['note',2048],['path',1024]])if(params[k]!==undefined&&(typeof params[k]!=='string'||!params[k].trim()||params[k].length>max))throw Error('INVALID_TEXT');
  if(method==='permission'&&!['revoked','read','edit','execute'].includes(params.mode))throw Error('INVALID_PERMISSION');
  if(method==='review'&&(typeof params.digest!=='string'||!/^[a-f0-9]{64}$/.test(params.digest)))throw Error('INVALID_DIGEST');
  if(method==='history'&&(!Number.isSafeInteger(params.beforeSeq)||params.beforeSeq<0))throw Error('INVALID_CURSOR');
  return {method,params};
}
module.exports={validate,publicValidate:(m,p)=>validate(m,p,false),internalValidate:(m,p)=>validate(m,p,true)};
