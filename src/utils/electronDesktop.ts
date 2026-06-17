interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: string[];
}

interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface HtmlPreviewWindow {
  webContents: {
    executeJavaScript: (code: string) => Promise<number>;
    printToPDF: (options: { printBackground: boolean; preferCSSPageSize?: boolean }) => Promise<Uint8Array>;
    capturePage: () => Promise<{ toPNG: () => Buffer }>;
    loadURL: (url: string) => Promise<void>;
  };
  loadFile: (filePath: string) => Promise<void>;
  setContentSize: (width: number, height: number) => void;
  destroy: () => void;
}

export interface ElectronRemoteBridge {
  dialog: {
    showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
  };
  BrowserWindow: new (options: Record<string, unknown>) => HtmlPreviewWindow;
}

declare global {
  interface Window {
    electron?: {
      remote?: ElectronRemoteBridge;
      ipcRenderer?: {
        send: (channel: string, ...args: unknown[]) => void;
        once: (channel: string, handler: (...args: unknown[]) => void) => void;
      };
    };
  }
}

/** Obsidian desktop exposes Electron via `window.electron.remote`; fall back to `require('electron').remote`. */
export function getElectronRemote(): ElectronRemoteBridge | null {
  if (window.electron?.remote) {
    return window.electron.remote;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only Electron bridge.
    const electron = require('electron') as {
      remote?: ElectronRemoteBridge;
      dialog?: ElectronRemoteBridge['dialog'];
      BrowserWindow?: ElectronRemoteBridge['BrowserWindow'];
    };
    if (electron.remote) return electron.remote;
    if (electron.dialog && electron.BrowserWindow) {
      return {
        dialog: electron.dialog,
        BrowserWindow: electron.BrowserWindow,
      };
    }
  } catch {
    // not on desktop
  }

  return null;
}
