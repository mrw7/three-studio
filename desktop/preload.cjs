// Minimal desktop descriptor for the Studio shell. No Node APIs, no IPC
// surface: the renderer only needs the platform label for window-chrome CSS.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ThreeStudioDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return
    ipcRenderer.send('three-studio:theme', theme)
  },
  getLicense() {
    return ipcRenderer.invoke('three-studio:license:get')
  },
  activateLicense(text) {
    return ipcRenderer.invoke('three-studio:license:activate', String(text ?? ''))
  },
  removeLicense() {
    return ipcRenderer.invoke('three-studio:license:remove')
  },
  manageLicense() {
    return ipcRenderer.invoke('three-studio:license:manage')
  },
  onLicenseChanged(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('three-studio:license', listener)
    return () => ipcRenderer.removeListener('three-studio:license', listener)
  },
})
