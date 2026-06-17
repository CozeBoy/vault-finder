import { App, Modal, setIcon, TFolder } from 'obsidian';
import type { I18nStrings } from '../i18n';

export interface FolderPickerLabels {
  title: string;
  selectCurrent: string;
  root: string;
  empty: string;
}

export function makeFolderPickerLabels(t: I18nStrings): FolderPickerLabels {
  return {
    title: t.folderPickerTitle,
    selectCurrent: t.folderPickerSelectCurrent,
    root: t.folderPickerRoot,
    empty: t.folderPickerEmpty,
  };
}

export class FolderPickerModal extends Modal {
  private currentPath = '';

  constructor(
    app: App,
    private labels: FolderPickerLabels,
    private onChoose: (path: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.labels.title);
    contentEl.addClass('vault-finder-folder-picker');
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.renderBreadcrumb();
    this.renderList();
    this.renderActions();
  }

  private renderBreadcrumb(): void {
    const crumb = this.contentEl.createEl('div', { cls: 'vault-finder-folder-picker-crumb' });
    const segments = this.currentPath ? this.currentPath.split('/') : [];

    const rootBtn = crumb.createEl('button', {
      cls: 'vault-finder-folder-picker-crumb-item',
      text: this.labels.root,
      type: 'button',
    });
    rootBtn.addEventListener('click', () => {
      this.currentPath = '';
      this.render();
    });

    let pathSoFar = '';
    for (const segment of segments) {
      crumb.createEl('span', { cls: 'vault-finder-folder-picker-crumb-sep', text: '/' });
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      const segPath = pathSoFar;
      const btn = crumb.createEl('button', {
        cls: 'vault-finder-folder-picker-crumb-item',
        text: segment,
        type: 'button',
      });
      btn.addEventListener('click', () => {
        this.currentPath = segPath;
        this.render();
      });
    }
  }

  private getCurrentFolder(): TFolder {
    if (!this.currentPath) return this.app.vault.getRoot();
    return this.app.vault.getFolderByPath(this.currentPath) ?? this.app.vault.getRoot();
  }

  private listSubfolders(): TFolder[] {
    const folder = this.getCurrentFolder();
    return folder.children
      .filter((child): child is TFolder => child instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private renderList(): void {
    const list = this.contentEl.createEl('div', { cls: 'vault-finder-folder-picker-list' });
    const subfolders = this.listSubfolders();

    if (subfolders.length === 0) {
      list.createEl('div', { cls: 'vault-finder-folder-picker-empty', text: this.labels.empty });
      return;
    }

    for (const sub of subfolders) {
      const row = list.createEl('button', {
        cls: 'vault-finder-folder-picker-row',
        type: 'button',
      });
      const icon = row.createSpan({ cls: 'vault-finder-folder-picker-row-icon' });
      setIcon(icon, 'folder');
      row.createSpan({ cls: 'vault-finder-folder-picker-row-name', text: sub.name });
      const arrow = row.createSpan({ cls: 'vault-finder-folder-picker-row-arrow' });
      setIcon(arrow, 'chevron-right');

      row.addEventListener('click', () => {
        this.currentPath = sub.path;
        this.render();
      });
    }
  }

  private renderActions(): void {
    const actions = this.contentEl.createEl('div', { cls: 'vault-finder-folder-picker-actions' });
    const displayPath = this.currentPath || this.labels.root;
    actions.createEl('div', { cls: 'vault-finder-folder-picker-target', text: displayPath });

    const selectBtn = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.labels.selectCurrent,
      type: 'button',
    });
    selectBtn.addEventListener('click', () => {
      this.onChoose(this.currentPath);
      this.close();
    });
  }
}
