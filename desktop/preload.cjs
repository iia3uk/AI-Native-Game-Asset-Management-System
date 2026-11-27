const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('assetViewerDesktop', {
  chooseFolder: () => ipcRenderer.invoke('asset-viewer:choose-folder'),
})
