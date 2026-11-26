'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sinal', {
  isDesktop: true,
  listSources: () => ipcRenderer.invoke('capture:list'),
  selectSource: (id, audio) => ipcRenderer.invoke('capture:select', { id, audio }),
  clearSource: () => ipcRenderer.invoke('capture:clear'),
  lanInfo: () => ipcRenderer.invoke('app:lan'),
  onRefit: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('capture:refit', handler)
    return () => ipcRenderer.removeListener('capture:refit', handler)
  },
})
