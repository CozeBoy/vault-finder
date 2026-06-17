import * as fs from 'fs';
import * as path from 'path';
import { FileSystemAdapter, type App } from 'obsidian';

export type ExportLinkMode = 'file' | 'pdf';

/** Vault-relative path → absolute filesystem path (desktop vaults). */
export function vaultPathToFullPath(app: App, vaultRelativePath: string): string {
  const normalized = vaultRelativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) return vaultRelativePath;

  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    try {
      return adapter.getFullPath(normalized);
    } catch {
      return path.join(adapter.getBasePath(), normalized);
    }
  }

  return normalized;
}

function normalizeLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function resolveVaultRelativePath(app: App, linkTarget: string): string {
  const trimmed = normalizeLinkTarget(linkTarget);
  if (!trimmed) return trimmed;

  const dest = app.metadataCache.getFirstLinkpathDest(trimmed, '');
  if (dest) return dest.path;

  const direct = app.vault.getAbstractFileByPath(trimmed);
  if (direct) return direct.path;

  if (!trimmed.endsWith('.md')) {
    const withMd = app.vault.getAbstractFileByPath(`${trimmed}.md`);
    if (withMd) return withMd.path;
  }

  return trimmed;
}

function vaultRelativeFromFullPath(app: App, fullPath: string): string | null {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;

  const base = path.normalize(adapter.getBasePath());
  const normalized = path.normalize(fullPath.split('#')[0] ?? fullPath);
  if (!normalized.startsWith(base)) return null;

  return normalized
    .slice(base.length)
    .replace(/^[/\\]/, '')
    .replace(/\\/g, '/');
}

/** Resolve wikilink / internal-link target to an absolute filesystem path. */
export function resolveLinkTargetToFullPath(app: App, rawTarget: string): string {
  const target = normalizeLinkTarget(rawTarget);
  if (!target || target.includes('://')) {
    return target;
  }
  if (path.isAbsolute(target)) {
    return target;
  }

  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const fragment = hashIdx >= 0 ? target.slice(hashIdx) : '';

  const vaultPath = resolveVaultRelativePath(app, pathPart);
  const fullPath = vaultPathToFullPath(app, vaultPath);
  return fragment ? `${fullPath}${fragment}` : fullPath;
}

function pathPartFrom(linkBody: string): string {
  return linkBody.split('#')[0]?.trim() ?? linkBody;
}

function fragmentFromFullPath(fullPath: string): string {
  const hashIdx = fullPath.indexOf('#');
  return hashIdx >= 0 ? fullPath.slice(hashIdx) : '';
}

/** Build a standards-compliant file:// URL (percent-encoded). */
export function pathToFileUrl(fullPath: string): string {
  const hashIdx = fullPath.indexOf('#');
  const pathOnlyPart = hashIdx >= 0 ? fullPath.slice(0, hashIdx) : fullPath;
  const fragment = hashIdx >= 0 ? fullPath.slice(hashIdx + 1) : '';

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node URL helper for desktop export.
  const { pathToFileURL } = require('url') as typeof import('url');
  const base = pathToFileURL(pathOnlyPart).href;
  return fragment ? `${base}#${encodeURIComponent(fragment)}` : base;
}

/** Open note in Obsidian — works in PDF readers that block file:// links. */
export function pathToObsidianOpenUrl(
  app: App,
  vaultRelativePath: string,
  fragment?: string,
): string {
  const vault = encodeURIComponent(app.vault.getName());
  const file = encodeURIComponent(vaultRelativePath);
  let url = `obsidian://open?vault=${vault}&file=${file}`;
  if (fragment) {
    const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment;
    url += `#${encodeURIComponent(frag)}`;
  }
  return url;
}

function vaultRelativeLinkLabel(vaultRelativePath: string, fullPath: string): string {
  return vaultRelativePath + fragmentFromFullPath(fullPath);
}

function exportLinkUrl(
  app: App,
  fullPath: string,
  vaultRelativePath: string,
  mode: ExportLinkMode,
): string {
  if (mode === 'pdf') {
    const hashIdx = fullPath.indexOf('#');
    const fragment = hashIdx >= 0 ? fullPath.slice(hashIdx + 1) : undefined;
    return pathToObsidianOpenUrl(app, vaultRelativePath, fragment);
  }
  return pathToFileUrl(fullPath);
}

function formatMarkdownSourceLink(label: string, url: string): string {
  const safeLabel = label.replace(/]/g, '\\]');
  return `[${safeLabel}](<${url}>)`;
}

function resolveLinkParts(
  app: App,
  linkBody: string,
): { fullPath: string; vaultRelativePath: string } {
  const vaultRelativePath = resolveVaultRelativePath(app, pathPartFrom(linkBody));
  const fullPath = resolveLinkTargetToFullPath(app, linkBody);
  return { fullPath, vaultRelativePath };
}

/** Replace [[vault-relative links]] with clickable export links. */
export function expandSourcePathsInMarkdown(
  app: App,
  markdown: string,
  mode: ExportLinkMode = 'file',
): string {
  let result = markdown.replace(/\[\[([^\]]+)]]/g, (_match, inner: string) => {
    const aliasSplit = inner.split('|');
    const linkBody = aliasSplit[0]?.trim() ?? inner;
    const { fullPath, vaultRelativePath } = resolveLinkParts(app, linkBody);
    const label = vaultRelativeLinkLabel(vaultRelativePath, fullPath);
    const url = exportLinkUrl(app, fullPath, vaultRelativePath, mode);
    return formatMarkdownSourceLink(label, url);
  });

  result = result.replace(/\[([^\]]*)]\(([^)]+)\)/g, (match, text: string, url: string) => {
    const trimmed = normalizeLinkTarget(url.replace(/^<|>$/g, ''));
    if (!trimmed || trimmed.startsWith('#')) return match;
    if (/^(https?|file|obsidian|mailto):/i.test(trimmed)) return match;

    const { fullPath, vaultRelativePath } = path.isAbsolute(trimmed)
      ? {
          fullPath: trimmed,
          vaultRelativePath:
            vaultRelativeFromFullPath(app, trimmed) ?? resolveVaultRelativePath(app, trimmed),
        }
      : resolveLinkParts(app, trimmed);
    const label = text.trim() || vaultRelativeLinkLabel(vaultRelativePath, fullPath);
    return formatMarkdownSourceLink(label, exportLinkUrl(app, fullPath, vaultRelativePath, mode));
  });

  return result;
}

function getActiveDocument(): Document {
  return window.activeDocument ?? document;
}

function htmlToElementContainer(html: string): HTMLElement {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const container = getActiveDocument().createElement('div');
  for (const child of Array.from(parsed.body.childNodes)) {
    container.appendChild(child.cloneNode(true));
  }
  return container;
}

function serializeElementChildren(container: HTMLElement): string {
  return Array.from(container.childNodes)
    .map((node) => new XMLSerializer().serializeToString(node))
    .join('');
}

function parseObsidianFileFromHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (!url.protocol.startsWith('obsidian')) return null;
    const file = url.searchParams.get('file');
    return file ? decodeURIComponent(file) : null;
  } catch {
    return null;
  }
}

/** Replace internal-link hrefs in rendered HTML with export-ready links. */
export function expandSourcePathsInHtml(
  app: App,
  html: string,
  mode: ExportLinkMode = 'file',
): string {
  if (!html.trim()) return html;

  const container = htmlToElementContainer(html);
  const anchors = Array.from(container.querySelectorAll('a'));
  for (const anchor of anchors) {
    const dataHref = anchor.getAttribute('data-href') ?? '';
    const href = anchor.getAttribute('href') ?? '';
    const linkTarget = normalizeLinkTarget(dataHref || href);

    if (/^obsidian:/i.test(href) || /^obsidian:/i.test(linkTarget)) {
      const vaultRel = parseObsidianFileFromHref(href) ?? parseObsidianFileFromHref(linkTarget);
      if (vaultRel) {
        anchor.textContent = vaultRel + (href.includes('#') ? href.slice(href.indexOf('#')) : '');
      }
      continue;
    }

    if (
      !linkTarget ||
      linkTarget.startsWith('#') ||
      /^(https?|file|mailto):/i.test(linkTarget)
    ) {
      continue;
    }

    const { fullPath, vaultRelativePath } = path.isAbsolute(linkTarget)
      ? {
          fullPath: linkTarget,
          vaultRelativePath:
            vaultRelativeFromFullPath(app, linkTarget) ??
            resolveVaultRelativePath(app, pathPartFrom(linkTarget)),
        }
      : resolveLinkParts(app, linkTarget);

    const label = vaultRelativeLinkLabel(vaultRelativePath, fullPath);
    const linkUrl = exportLinkUrl(app, fullPath, vaultRelativePath, mode);

    anchor.textContent = label;
    anchor.setAttribute('href', linkUrl);
    anchor.setAttribute('title', label);
    anchor.removeAttribute('data-href');
    anchor.classList.remove('internal-link');
  }

  return serializeElementChildren(container);
}

/** Verify export targets exist on disk (desktop vaults). */
export function verifyExportFileExists(fullPath: string): boolean {
  const hashIdx = fullPath.indexOf('#');
  const pathOnlyPart = hashIdx >= 0 ? fullPath.slice(0, hashIdx) : fullPath;
  try {
    return fs.existsSync(pathOnlyPart);
  } catch {
    return false;
  }
}
