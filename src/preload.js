'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('firebaseApi', {
  fetchRootKeys: () => ipcRenderer.invoke('fetch-root-keys'),
  fetchNodeChildren: (targetPath) => ipcRenderer.invoke('fetch-node-children', targetPath),
  updateNodeValue: (payload) => ipcRenderer.invoke('update-node-value', payload),
  addNodeKey: (payload) => ipcRenderer.invoke('add-node-key', payload),
  deleteNode: (targetPath) => ipcRenderer.invoke('delete-node', targetPath),
  searchPlayerId: (playerId) => ipcRenderer.invoke('search-player-id', playerId),
  createLocalBackup: () => ipcRenderer.invoke('create-local-backup'),
  exitApp: () => ipcRenderer.invoke('app-exit')
});
