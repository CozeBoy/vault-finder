import { Notice, type App } from 'obsidian';

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

export async function saveMarkdownToFolder(
  app: App,
  folderPath: string,
  basename: string,
  markdown: string,
  notices: { saved: (path: string) => string; failed: string },
): Promise<void> {
  const folder = folderPath.trim().replace(/\/+$/, '');
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
  } catch {
    new Notice(notices.failed);
  }
}
