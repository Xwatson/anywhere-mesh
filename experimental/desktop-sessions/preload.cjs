'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=(m,p={})=>ipcRenderer.invoke('desktop:request',m,p);
contextBridge.exposeInMainWorld('desktop',Object.freeze({
  state:()=>invoke('state'),connect:()=>invoke('connect'),disconnect:()=>invoke('disconnect'),chooseWorkspace:()=>invoke('chooseWorkspace'),
  selectWorkspace:workspaceId=>invoke('selectWorkspace',{workspaceId}),permission:(workspaceId,mode)=>invoke('permission',{workspaceId,mode}),
  createSession:(workspaceId,title)=>invoke('createSession',{workspaceId,title}),selectSession:sessionId=>invoke('selectSession',{sessionId}),
  send:(sessionId,text)=>invoke('send',{sessionId,text}),stop:(sessionId,turnId)=>invoke('stop',{sessionId,turnId}),
  history:(sessionId,beforeSeq=0)=>invoke('history',{sessionId,beforeSeq}),retry:requestId=>invoke('retry',{requestId}),
  reviewPreview:(sessionId,turnId)=>invoke('reviewPreview',{sessionId,turnId}),review:(sessionId,turnId,digest,note)=>invoke('review',{sessionId,turnId,digest,note}),
}));
