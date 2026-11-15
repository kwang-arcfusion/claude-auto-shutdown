import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '../shared/api';
import type { AppState, Settings } from '../shared/types';

const api: Api = {
  getState: () => ipcRenderer.invoke('state:get') as Promise<AppState>,
  arm: () => ipcRenderer.invoke('arm') as Promise<void>,
  disarm: () => ipcRenderer.invoke('disarm') as Promise<void>,
  cancel: () => ipcRenderer.invoke('cancel') as Promise<void>,
  pollNow: () => ipcRenderer.invoke('poll-now') as Promise<void>,
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:update', patch) as Promise<Settings>,
  resetSettings: () => ipcRenderer.invoke('settings:reset') as Promise<Settings>,
  openLogFolder: () => ipcRenderer.invoke('open-log-folder') as Promise<void>,
  onState: (callback) => {
    const listener = (_event: IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('state', listener);
    return () => {
      ipcRenderer.removeListener('state', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
