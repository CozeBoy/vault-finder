import { Notice, type App } from 'obsidian';
import { normalizeSaveFolderPath } from '../settings';

export function sanitizeNoteBasename(name: string): string {
  const trimmed = name.trim().slice(0, 80);
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || '检索结果';
}

export function buildArticleFilename(query: string): string {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join('');
  return `${sanitizeNoteBasename(`检索-${query}`)}-${stamp}`;
}

/** @returns Saved file path on success, or null on failure. */
export async function saveMarkdownToFolder(
  app: App,
  folderPath: string,
  basename: string,
  markdown: string,
  notices: { saved: (path: string) => string; failed: string },
): Promise<string | null> {
  const folder = normalizeSaveFolderPath(folderPath);
  let path = folder ? `${folder}/${basename}.md` : `${basename}.md`;

  try {
    let suffix = 1;
    while (await app.vault.adapter.exists(path)) {
      path = folder
        ? `${folder}/${basename}-${suffix}.md`
        : `${basename}-${suffix}.md`;
      suffix++;
    }
    const file = await app.vault.create(path, markdown);
    new Notice(notices.saved(file.path));
    return file.path;
  } catch {
    new Notice(notices.failed);
    return null;
  }
}

/** @returns Vault-relative path on success, or null on failure. */
export async function writeExportToVault(
  app: App,
  folderPath: string,
  basename: string,
  extension: string,
  content: string | Uint8Array | Buffer,
): Promise<string | null> {
  const folder = normalizeSaveFolderPath(folderPath);
  let vaultPath = folder ? `${folder}/${basename}.${extension}` : `${basename}.${extension}`;

  try {
    let suffix = 1;
    while (await app.vault.adapter.exists(vaultPath)) {
      vaultPath = folder
        ? `${folder}/${basename}-${suffix}.${extension}`
        : `${basename}-${suffix}.${extension}`;
      suffix++;
    }
    if (typeof content === 'string') {
      await app.vault.create(vaultPath, content);
    } else {
      const bytes = content instanceof Buffer ? new Uint8Array(content) : content;
      const arrayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(arrayBuffer).set(bytes);
      await app.vault.adapter.writeBinary(vaultPath, arrayBuffer);
    }
    return vaultPath;
  } catch {
    return null;
  }
}
