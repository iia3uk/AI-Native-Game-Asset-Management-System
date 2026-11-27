const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('assetViewerDesktop', {
  chooseFolder: () => ipcRenderer.invoke('asset-viewer:choose-folder'),
  selectedFilePath: file => webUtils.getPathForFile(file),
})
