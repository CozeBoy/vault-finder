import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Notice, type App } from 'obsidian';
import { writeExportToVault } from './articleSave';
import { getElectronRemote, type ElectronRemoteBridge } from '../utils/electronDesktop';
import { expandSourcePathsInHtml, expandSourcePathsInMarkdown, vaultPathToFullPath, type ExportLinkMode } from '../utils/vaultPath';

export type ArticleExportFormat = 'md' | 'html' | 'pdf' | 'png';

export interface ArticleExportNotices {
  exported: (path: string) => string;
  failed: string;
}

interface SaveDialogFilter {
  name: string;
  extensions: string[];
}

type ExportPayload = string | Uint8Array | Buffer;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function wrapArticleHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    line-height: 1.65;
    max-width: 760px;
    margin: 2rem auto;
    padding: 0 1.25rem 2rem;
    color: #1e1e1e;
    background: #fff;
  }
  h1, h2, h3, h4 { margin-top: 1.4em; margin-bottom: 0.5em; line-height: 1.3; }
  p { margin: 0.75em 0; }
  ul, ol { padding-left: 1.5em; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  pre { background: #f5f5f5; padding: 0.75em 1em; border-radius: 6px; overflow-x: auto; }
  code { background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 4px; }
  blockquote {
    border-left: 4px solid #d0d0d0;
    margin: 1em 0;
    padding: 0.25em 0 0.25em 1em;
    color: #444;
  }
  a { color: #2563eb; text-decoration: none; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function filterForFormat(format: ArticleExportFormat): SaveDialogFilter {
  switch (format) {
    case 'md':
      return { name: 'Markdown', extensions: ['md'] };
    case 'html':
      return { name: 'HTML', extensions: ['html', 'htm'] };
    case 'pdf':
      return { name: 'PDF', extensions: ['pdf'] };
    case 'png':
      return { name: 'PNG Image', extensions: ['png'] };
  }
}

function extensionForFormat(format: ArticleExportFormat): string {
  switch (format) {
    case 'md':
      return 'md';
    case 'html':
      return 'html';
    case 'pdf':
      return 'pdf';
    case 'png':
      return 'png';
  }
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function revealInFileManager(filePath: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only reveal in Finder/Explorer.
    const { shell } = require('electron') as {
      shell: { showItemInFolder: (targetPath: string) => void };
    };
    shell.showItemInFolder(filePath);
  } catch {
    // ignore
  }
}

function assertBinaryExportWritten(filePath: string, minBytes = 100): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Export file was not created: ${filePath}`);
  }
  if (fs.statSync(filePath).size < minBytes) {
    throw new Error(`Export file is empty: ${filePath}`);
  }
}

async function pickExportPath(
  remote: ElectronRemoteBridge,
  format: ArticleExportFormat,
  basename: string,
  dialogTitle: string,
): Promise<string | null> {
  const ext = extensionForFormat(format);
  const result = await remote.dialog.showSaveDialog({
    title: dialogTitle,
    defaultPath: `${basename}.${ext}`,
    filters: [filterForFormat(format)],
    properties: ['showOverwriteConfirmation'],
  });

  if (result.canceled || !result.filePath) return null;

  let filePath = result.filePath;
  if (!filePath.toLowerCase().endsWith(`.${ext}`)) {
    filePath = `${filePath}.${ext}`;
  }
  return filePath;
}

async function loadHtmlInWindow(
  win: import('../utils/electronDesktop').HtmlPreviewWindow,
  html: string,
  useDataUrl: boolean,
): Promise<void> {
  if (useDataUrl) {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await win.webContents.loadURL(dataUrl);
    return;
  }

  const tmpPath = path.join(os.tmpdir(), `vault-finder-export-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, 'utf8');
  try {
    await win.loadFile(tmpPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

async function withHtmlPreviewWindow<T>(
  remote: ElectronRemoteBridge,
  html: string,
  useDataUrl: boolean,
  run: (win: import('../utils/electronDesktop').HtmlPreviewWindow) => Promise<T>,
): Promise<T> {
  const win = new remote.BrowserWindow({
    show: false,
    width: 820,
    height: 600,
    webPreferences: {
      javascript: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  try {
    await loadHtmlInWindow(win, html, useDataUrl);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    const scrollHeight = await win.webContents.executeJavaScript(
      'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)',
    );
    const height = Math.min(Math.max(scrollHeight + 48, 400), 16000);
    win.setContentSize(820, height);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    return await run(win);
  } finally {
    win.destroy();
  }
}

async function buildExportPayload(
  remote: ElectronRemoteBridge,
  format: ArticleExportFormat,
  markdown: string,
  html: string,
): Promise<ExportPayload> {
  switch (format) {
    case 'md':
      return markdown;
    case 'html':
      return html;
    case 'pdf':
      return withHtmlPreviewWindow(remote, html, true, (win) =>
        win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }),
      );
    case 'png':
      return withHtmlPreviewWindow(remote, html, false, async (win) => {
        const image = await win.webContents.capturePage();
        return image.toPNG();
      });
  }
}

function writeExportToAbsolutePath(filePath: string, payload: ExportPayload): void {
  ensureParentDir(filePath);
  if (typeof payload === 'string') {
    fs.writeFileSync(filePath, payload, 'utf8');
    return;
  }
  fs.writeFileSync(filePath, Buffer.from(payload));
}

async function exportViaVault(
  app: App,
  format: ArticleExportFormat,
  basename: string,
  markdown: string,
  html: string,
  notices: ArticleExportNotices,
  pickVaultFolder: () => Promise<string | null>,
  onVaultFolderUsed?: (folder: string) => void,
): Promise<void> {
  const folder = await pickVaultFolder();
  if (!folder) return;

  const remote = getElectronRemote();
  if (!remote) {
    new Notice(notices.failed);
    return;
  }

  try {
    const payload = await buildExportPayload(remote, format, markdown, html);
    const ext = extensionForFormat(format);
    const vaultPath = await writeExportToVault(app, folder, basename, ext, payload);
    if (!vaultPath) {
      new Notice(notices.failed);
      return;
    }
    if (format === 'pdf' || format === 'png') {
      assertBinaryExportWritten(vaultPathToFullPath(app, vaultPath));
      revealInFileManager(vaultPathToFullPath(app, vaultPath));
    }
    onVaultFolderUsed?.(folder);
    new Notice(notices.exported(vaultPath));
  } catch (err) {
    console.error('[vault-finder] vault export failed:', err);
    new Notice(notices.failed);
  }
}

export async function exportArticleToDisk(params: {
  app: App;
  format: ArticleExportFormat;
  markdown: string;
  bodyHtml: string;
  basename: string;
  dialogTitle: string;
  notices: ArticleExportNotices;
  pickVaultFolder: () => Promise<string | null>;
  onVaultFolderUsed?: (folder: string) => void;
  renderMarkdownHtml?: (markdown: string) => Promise<string>;
}): Promise<void> {
  const {
    app,
    format,
    markdown,
    bodyHtml,
    basename,
    dialogTitle,
    notices,
    pickVaultFolder,
    onVaultFolderUsed,
  } = params;
  const title = basename;
  const linkMode: ExportLinkMode = format === 'pdf' ? 'pdf' : 'file';
  const exportMarkdown =
    format === 'png' ? markdown : expandSourcePathsInMarkdown(app, markdown, linkMode);

  let exportBodyHtml: string;
  if (format === 'png') {
    exportBodyHtml = bodyHtml ? bodyHtml : `<pre>${escapeHtml(markdown)}</pre>`;
  } else if (params.renderMarkdownHtml) {
    exportBodyHtml = await params.renderMarkdownHtml(exportMarkdown);
    exportBodyHtml = expandSourcePathsInHtml(app, exportBodyHtml, linkMode);
  } else {
    exportBodyHtml = bodyHtml
      ? expandSourcePathsInHtml(app, bodyHtml, linkMode)
      : `<pre>${escapeHtml(exportMarkdown)}</pre>`;
  }
  const html = wrapArticleHtml(title, exportBodyHtml);

  const remote = getElectronRemote();
  if (!remote) {
    await exportViaVault(
      app,
      format,
      basename,
      exportMarkdown,
      html,
      notices,
      pickVaultFolder,
      onVaultFolderUsed,
    );
    return;
  }

  try {
    let filePath: string | null;
    try {
      filePath = await pickExportPath(remote, format, basename, dialogTitle);
    } catch (err) {
      console.error('[vault-finder] save dialog failed:', err);
      await exportViaVault(
        app,
        format,
        basename,
        exportMarkdown,
        html,
        notices,
        pickVaultFolder,
        onVaultFolderUsed,
      );
      return;
    }

    if (!filePath) return;

    const payload = await buildExportPayload(remote, format, exportMarkdown, html);
    writeExportToAbsolutePath(filePath, payload);
    if (format === 'pdf' || format === 'png') {
      assertBinaryExportWritten(filePath);
      revealInFileManager(filePath);
    }
    new Notice(notices.exported(filePath));
  } catch (err) {
    console.error('[vault-finder] export failed:', err);
    new Notice(notices.failed);
  }
}
