import type { App, TAbstractFile } from 'obsidian';

export async function openVaultLink(app: App, rawLink: string): Promise<void> {
  const link = decodeURIComponent(rawLink.trim());
  if (!link) return;

  let target = link;
  const wikiMatch = link.match(/^\[\[(.+?)]]$/);
  if (wikiMatch?.[1]) {
    target = wikiMatch[1].split('|')[0]?.trim() ?? target;
  }

  const dest = app.metadataCache.getFirstLinkpathDest(target, '');
  if (dest) {
    await app.workspace.openLinkText(dest.path, '', false);
    return;
  }

  const direct = resolveFileByPath(app, target);
  if (direct) {
    await app.workspace.openLinkText(direct.path, '', false);
    return;
  }

  await app.workspace.openLinkText(target, '', false);
}

function resolveFileByPath(app: App, path: string): TAbstractFile | null {
  const normalized = path.replace(/^\[\[|\]\]$/g, '');
  const direct = app.vault.getAbstractFileByPath(normalized);
  if (direct) return direct;

  if (!normalized.endsWith('.md')) {
    return app.vault.getAbstractFileByPath(`${normalized}.md`);
  }
  return null;
}

export function attachInternalLinkHandler(
  container: HTMLElement,
  app: App,
  register: (el: HTMLElement, type: 'click', handler: (evt: MouseEvent) => void) => void,
): void {
  register(container, 'click', (evt) => {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;

    const anchor = target.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href') ?? '';
    const dataHref = anchor.getAttribute('data-href') ?? '';
    const isInternal =
      anchor.classList.contains('internal-link') ||
      (href.length > 0 && !href.includes('://') && !href.startsWith('#'));

    if (!isInternal) return;

    evt.preventDefault();
    evt.stopPropagation();
    void openVaultLink(app, dataHref || href);
  });
}
