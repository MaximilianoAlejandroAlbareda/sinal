'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sinal', {
  isDesktop: true,
  listSources: () => ipcRenderer.invoke('capture:list'),
  selectSource: (id, audio) => ipcRenderer.invoke('capture:select', { id, audio }),
  clearSource: () => ipcRenderer.invoke('capture:clear'),
  lanInfo: () => ipcRenderer.invoke('app:lan'),
  listAudioProcesses: () => ipcRenderer.invoke('audio:list'),
  resolveAudioForSource: (sourceId) => ipcRenderer.invoke('audio:resolve', sourceId),
  startAudioCapture: (pid) => ipcRenderer.invoke('audio:start', pid),
  stopAudioCapture: () => ipcRenderer.invoke('audio:stop'),
  onAudioData: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('audio:data', handler)
    return () => ipcRenderer.removeListener('audio:data', handler)
  },
  onRefit: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('capture:refit', handler)
    return () => ipcRenderer.removeListener('capture:refit', handler)
  },
})
