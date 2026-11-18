'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopDevice',Object.freeze({
  request:(method,params={})=>ipcRenderer.invoke('desktop:request',method,params)
}));
