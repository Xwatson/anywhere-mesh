'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, params = {}) => ipcRenderer.invoke('desktop:request', method, params);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  state: () => invoke('state'), connect: () => invoke('connect'), disconnect: () => invoke('disconnect'),
  permission: mode => invoke('permission', { mode }), run: action => invoke('run', { action }),
  task: id => invoke('task', { id }), cancel: id => invoke('cancel', { id }),
  reviewPreview: id => invoke('reviewPreview', { id }), review: (id, digest, note) => invoke('review', { id, digest, note }),
}));
