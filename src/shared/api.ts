import type { AppState, Settings } from './types';

/** The API the preload script exposes to the renderer as `window.api`. */
export interface Api {
  getState(): Promise<AppState>;
  arm(): Promise<void>;
  disarm(): Promise<void>;
  cancel(): Promise<void>;
  pollNow(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  openLogFolder(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}
