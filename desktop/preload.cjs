const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('assetViewerDesktop', {
  chooseFolder: () => ipcRenderer.invoke('asset-viewer:choose-folder'),
  cleanupSource: jobId => ipcRenderer.invoke('asset-viewer:cleanup-source', jobId),
  cleanupFolderRun: (id, action) => ipcRenderer.invoke('asset-viewer:cleanup-folder-run', id, action),
  restoreCleanupConfirmation: () => ipcRenderer.invoke('asset-viewer:restore-cleanup-confirmation'),
  selectedFilePath: file => webUtils.getPathForFile(file),
})
