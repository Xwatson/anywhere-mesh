'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopDevice',Object.freeze({
  request:(method,params={})=>ipcRenderer.invoke('desktop:request',method,params),
  onEvent:(listener)=>{
    if(typeof listener!=='function') return ()=>{};
    const handler=(_event,data)=>listener(data);
    ipcRenderer.on('desktop:event',handler);
    return ()=>ipcRenderer.removeListener('desktop:event',handler);
  }
}));
