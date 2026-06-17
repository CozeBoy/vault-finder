import * as fs from 'fs';
import * as path from 'path';
import { FileSystemAdapter, type App } from 'obsidian';
import type { SerializedIndex } from './types';
import { getPluginDir, getVaultBasePath, openPathInFileManager } from './vectorCacheStorage';

export const KEYWORD_CACHE_FILENAME = 'minisearch.json';
export const PLUGIN_KEYWORD_CACHE_DIR_NAME = 'keyword-cache';

export { openPathInFileManager };

export function defaultKeywordCacheFolderSetting(pluginId: string): string {
  return `.obsidian/plugins/${pluginId}/${PLUGIN_KEYWORD_CACHE_DIR_NAME}`;
}

export function resolveKeywordCacheDir(
  app: App,
  pluginId: string,
  folderSetting: string,
): string | null {
  const vaultBase = getVaultBasePath(app);
  const pluginDir = getPluginDir(app, pluginId);
  if (!vaultBase || !pluginDir) return null;

  const custom = folderSetting.trim();
  if (!custom) {
    return path.join(pluginDir, PLUGIN_KEYWORD_CACHE_DIR_NAME);
  }
  if (path.isAbsolute(custom)) {
    return path.normalize(custom);
  }
  return path.join(vaultBase, custom.replace(/^\/+/, ''));
}

export function formatKeywordCacheFolderDisplay(
  app: App,
  pluginId: string,
  folderSetting: string,
): string {
  const resolved = resolveKeywordCacheDir(app, pluginId, folderSetting);
  if (resolved) return resolved;
  const custom = folderSetting.trim();
  if (custom) return custom;
  return defaultKeywordCacheFolderSetting(pluginId);
}

export function ensureKeywordCacheDir(
  app: App,
  pluginId: string,
  folderSetting: string,
): string | null {
  const dir = resolveKeywordCacheDir(app, pluginId, folderSetting);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export class KeywordCacheStorage {
  constructor(
    private app: App,
    private pluginId: string,
    private getFolderSetting: () => string,
  ) {}

  resolveDir(): string | null {
    return resolveKeywordCacheDir(this.app, this.pluginId, this.getFolderSetting());
  }

  resolveDirForSetting(folderSetting: string): string | null {
    return resolveKeywordCacheDir(this.app, this.pluginId, folderSetting);
  }

  private cacheFilePath(dir: string): string {
    return path.join(dir, KEYWORD_CACHE_FILENAME);
  }

  loadFromDir(dir: string): SerializedIndex | null {
    try {
      const filePath = this.cacheFilePath(dir);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as SerializedIndex;
      if (typeof data !== 'object' || data === null || typeof data.miniSearch !== 'string') {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  load(): SerializedIndex | null {
    const dir = this.resolveDir();
    if (!dir) return null;
    return this.loadFromDir(dir);
  }

  saveToDir(dir: string, data: SerializedIndex): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = this.cacheFilePath(dir);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  save(data: SerializedIndex): boolean {
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

  migrate(fromDir: string | null, toDir: string | null, inMemory: SerializedIndex | null): boolean {
    if (!toDir) return false;
    if (fromDir === toDir) return true;

    const hasInMemory = inMemory !== null && inMemory.miniSearch.length > 0;

    if (hasInMemory && inMemory) {
      this.saveToDir(toDir, inMemory);
    } else if (fromDir) {
      const fromFile = this.loadFromDir(fromDir);
      if (fromFile && !this.loadFromDir(toDir)) {
        this.saveToDir(toDir, fromFile);
      }
    }

    if (fromDir && fromDir !== toDir) {
      this.removeCacheFile(fromDir);
    }
    return true;
  }
}
