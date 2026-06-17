import * as fs from 'fs';
import * as path from 'path';
import { FileSystemAdapter, type App } from 'obsidian';
import type { SerializedVectorIndex } from './vectorIndex';

export const VECTOR_CACHE_FILENAME = 'vectors.json';
export const PLUGIN_VECTOR_CACHE_DIR_NAME = 'vector-cache';

export function getVaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return null;
}

export function getPluginDir(app: App, pluginId: string): string | null {
  const base = getVaultBasePath(app);
  if (!base) return null;
  return path.join(base, '.obsidian', 'plugins', pluginId);
}

export function defaultVectorCacheFolderSetting(pluginId: string): string {
  return `.obsidian/plugins/${pluginId}/${PLUGIN_VECTOR_CACHE_DIR_NAME}`;
}

export function resolveVectorCacheDir(
  app: App,
  pluginId: string,
  folderSetting: string,
): string | null {
  const vaultBase = getVaultBasePath(app);
  const pluginDir = getPluginDir(app, pluginId);
  if (!vaultBase || !pluginDir) return null;

  const custom = folderSetting.trim();
  if (!custom) {
    return path.join(pluginDir, PLUGIN_VECTOR_CACHE_DIR_NAME);
  }
  if (path.isAbsolute(custom)) {
    return path.normalize(custom);
  }
  return path.join(vaultBase, custom.replace(/^\/+/, ''));
}

export function formatVectorCacheFolderDisplay(
  app: App,
  pluginId: string,
  folderSetting: string,
): string {
  const resolved = resolveVectorCacheDir(app, pluginId, folderSetting);
  if (resolved) return resolved;
  const custom = folderSetting.trim();
  if (custom) return custom;
  return defaultVectorCacheFolderSetting(pluginId);
}

export function ensureVectorCacheDir(
  app: App,
  pluginId: string,
  folderSetting: string,
): string | null {
  const dir = resolveVectorCacheDir(app, pluginId, folderSetting);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export async function openPathInFileManager(folderPath: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as {
      shell: { openPath: (targetPath: string) => Promise<string> };
    };
    const error = await shell.openPath(folderPath);
    return error === '';
  } catch {
    return false;
  }
}

export function stripLegacyPluginCachesFromRecord(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { vectorCache: _v, indexCache: _i, ...rest } = data;
  return rest;
}

/** @deprecated Use stripLegacyPluginCachesFromRecord */
export function stripLegacyVectorCacheFromRecord(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return stripLegacyPluginCachesFromRecord(data);
}

function mergeVectorCache(
  primary: SerializedVectorIndex,
  secondary: SerializedVectorIndex,
): SerializedVectorIndex {
  const byPath = new Map(primary.entries.map((entry) => [entry.path, entry]));
  for (const entry of secondary.entries) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }
  return {
    version: primary.version,
    modelKey: primary.modelKey,
    entries: [...byPath.values()],
  };
}

export class VectorCacheStorage {
  constructor(
    private app: App,
    private pluginId: string,
    private getFolderSetting: () => string,
  ) {}

  resolveDir(): string | null {
    return resolveVectorCacheDir(this.app, this.pluginId, this.getFolderSetting());
  }

  resolveDirForSetting(folderSetting: string): string | null {
    return resolveVectorCacheDir(this.app, this.pluginId, folderSetting);
  }

  private cacheFilePath(dir: string): string {
    return path.join(dir, VECTOR_CACHE_FILENAME);
  }

  loadFromDir(dir: string): SerializedVectorIndex | null {
    try {
      const filePath = this.cacheFilePath(dir);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as SerializedVectorIndex;
      if (typeof data !== 'object' || data === null || !Array.isArray(data.entries)) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  load(): SerializedVectorIndex | null {
    const dir = this.resolveDir();
    if (!dir) return null;
    return this.loadFromDir(dir);
  }

  saveToDir(dir: string, data: SerializedVectorIndex): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = this.cacheFilePath(dir);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  save(data: SerializedVectorIndex): boolean {
    const dir = this.resolveDir();
    if (!dir) return false;
    return this.saveToDir(dir, data);
  }

  removeCacheFile(dir: string): void {
    try {
      const filePath = this.cacheFilePath(dir);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }

  migrate(
    fromDir: string | null,
    toDir: string | null,
    inMemory: SerializedVectorIndex | null,
  ): boolean {
    if (!toDir) return false;
    if (fromDir === toDir) return true;

    const hasInMemory = inMemory !== null && inMemory.entries.length > 0;

    if (hasInMemory && inMemory) {
      this.saveToDir(toDir, inMemory);
    } else if (fromDir) {
      const fromFile = this.loadFromDir(fromDir);
      if (fromFile) {
        const atDest = this.loadFromDir(toDir);
        if (!atDest) {
          this.saveToDir(toDir, fromFile);
        } else {
          this.saveToDir(toDir, mergeVectorCache(atDest, fromFile));
        }
      }
    }

    if (fromDir && fromDir !== toDir) {
      this.removeCacheFile(fromDir);
    }
    return true;
  }
}
