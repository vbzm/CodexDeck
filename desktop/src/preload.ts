import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('launcher', {
  snapshot: () => ipcRenderer.invoke('launcher:snapshot'),
  logs: () => ipcRenderer.invoke('launcher:logs'),
  refresh: () => ipcRenderer.invoke('launcher:refresh'),
  startAll: () => ipcRenderer.invoke('launcher:start-all'),
  startDesktop: () => ipcRenderer.invoke('launcher:start-desktop'),
  restartDesktop: () => ipcRenderer.invoke('launcher:restart-desktop'),
  stopDesktop: () => ipcRenderer.invoke('launcher:stop-desktop'),
  startGateway: () => ipcRenderer.invoke('launcher:start-gateway'),
  stopGateway: () => ipcRenderer.invoke('launcher:stop-gateway'),
  openWeb: () => ipcRenderer.invoke('launcher:open-web'),
  saveSettings: (input: unknown) => ipcRenderer.invoke('launcher:save-settings', input),
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke('launcher:set-theme', theme),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('launcher:state', listener);
    return () => ipcRenderer.removeListener('launcher:state', listener);
  },
  onLog: (callback: (entry: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: unknown) => callback(entry);
    ipcRenderer.on('launcher:log', listener);
    return () => ipcRenderer.removeListener('launcher:log', listener);
  },
});
