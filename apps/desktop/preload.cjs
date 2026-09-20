/**
 * The only thing the window is allowed to reach.
 *
 * No node integration, no remote module: the renderer gets a fixed list of
 * calls and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron')

const changeListeners = new Set()
const logListeners = new Set()

ipcRenderer.on('s2s:change', () => changeListeners.forEach((fn) => fn()))
ipcRenderer.on('s2s:log', (_e, line) => logListeners.forEach((fn) => fn(line)))

contextBridge.exposeInMainWorld('s2sBridge', {
  me: () => ipcRenderer.invoke('s2s:me'),

  snapshot: (q) => ipcRenderer.invoke('s2s:snapshot', q),
  act: (action, payload) => ipcRenderer.invoke('s2s:act', action, payload),
  status: () => ipcRenderer.invoke('s2s:status'),
  media: (blob) => ipcRenderer.invoke('s2s:media', blob),
  addMedia: (data) => ipcRenderer.invoke('s2s:addMedia', data),
  exportKey: () => ipcRenderer.invoke('s2s:exportKey'),
  copy: (text) => ipcRenderer.invoke('s2s:copy', text),

  onChange (fn) {
    changeListeners.add(fn)
    return () => changeListeners.delete(fn)
  },
  onLog (fn) {
    logListeners.add(fn)
    return () => logListeners.delete(fn)
  }
})
