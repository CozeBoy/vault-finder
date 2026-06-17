import type { App } from 'obsidian';

export interface ScopePickerOptions {
  label: string;
  entireVaultLabel: string;
  filterPlaceholder: string;
  value: string;
  folders: string[];
  onChange: (path: string) => void;
}

export class ScopePicker {
  private rootEl: HTMLElement;
  private labelEl: HTMLElement;
  private triggerEl: HTMLButtonElement;
  private popoverEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private filterEl: HTMLInputElement | null = null;
  private value: string;
  private readonly onChange: (path: string) => void;
  private entireVaultLabel: string;
  private filterPlaceholder: string;
  private folders: string[];
  private closeHandler: ((evt: MouseEvent) => void) | null = null;

  constructor(parent: HTMLElement, options: ScopePickerOptions) {
    this.value = options.value;
    this.onChange = options.onChange;
    this.entireVaultLabel = options.entireVaultLabel;
    this.filterPlaceholder = options.filterPlaceholder;
    this.folders = options.folders;

    this.rootEl = parent.createEl('div', { cls: 'vault-finder-scope-picker' });
    this.labelEl = this.rootEl.createEl('span', { text: options.label, cls: 'vault-finder-label' });

    this.triggerEl = this.rootEl.createEl('button', {
      cls: 'vault-finder-scope-trigger',
      type: 'button',
    });
    this.updateTriggerLabel();

    this.triggerEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      this.togglePopover();
    });
  }

  setFolders(folders: string[]): void {
    this.folders = folders;
    this.renderList(this.filterEl?.value ?? '');
  }

  setValue(value: string): void {
    this.value = value;
    this.updateTriggerLabel();
  }

  getValue(): string {
    return this.value;
  }

  updateLocale(options: Pick<ScopePickerOptions, 'label' | 'entireVaultLabel' | 'filterPlaceholder'>): void {
    this.entireVaultLabel = options.entireVaultLabel;
    this.filterPlaceholder = options.filterPlaceholder;
    this.labelEl.setText(options.label);
    this.updateTriggerLabel();
    if (this.filterEl) {
      this.filterEl.setAttr('placeholder', options.filterPlaceholder);
    }
    if (this.listEl) {
      this.renderList(this.filterEl?.value ?? '');
    }
  }

  destroy(): void {
    this.closePopover();
    this.rootEl.remove();
  }

  private updateTriggerLabel(): void {
    const display = this.value.trim() || this.entireVaultLabel;
    this.triggerEl.empty();
    const text = this.triggerEl.createEl('span', {
      cls: 'vault-finder-scope-trigger-text',
      text: display,
    });
    text.setAttr('title', display);
    this.triggerEl.createEl('span', { cls: 'vault-finder-scope-trigger-icon', text: '▾' });
  }

  private togglePopover(): void {
    if (this.popoverEl) {
      this.closePopover();
      return;
    }
    this.openPopover();
  }

  private openPopover(): void {
    this.popoverEl = this.rootEl.createEl('div', { cls: 'vault-finder-scope-popover' });

    this.filterEl = this.popoverEl.createEl('input', {
      type: 'search',
      cls: 'vault-finder-scope-filter',
      attr: { placeholder: this.filterPlaceholder },
    });

    this.listEl = this.popoverEl.createEl('div', { cls: 'vault-finder-scope-list' });
    this.renderList('');

    this.filterEl.addEventListener('input', () => {
      this.renderList(this.filterEl?.value ?? '');
    });

    this.filterEl.focus();

    this.closeHandler = (evt: MouseEvent) => {
      const target = evt.target;
      if (!(target instanceof Node)) return;
      if (this.rootEl.contains(target)) return;
      this.closePopover();
    };
    window.setTimeout(() => {
      if (this.closeHandler) {
        window.activeDocument.addEventListener('click', this.closeHandler, true);
      }
    }, 0);
  }

  private renderList(query: string): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const q = query.trim().toLowerCase();

    const entireBtn = this.listEl.createEl('button', {
      cls: `vault-finder-scope-item${this.value === '' ? ' is-active' : ''}`,
      type: 'button',
      text: this.entireVaultLabel,
    });
    entireBtn.addEventListener('click', () => this.select(''));

    for (const folder of this.folders) {
      if (q && !folder.toLowerCase().includes(q)) continue;
      const btn = this.listEl.createEl('button', {
        cls: `vault-finder-scope-item${this.value === folder ? ' is-active' : ''}`,
        type: 'button',
      });
      btn.createEl('span', { text: folder, cls: 'vault-finder-scope-item-text' });
      btn.setAttr('title', folder);
      btn.addEventListener('click', () => this.select(folder));
    }
  }

  private select(path: string): void {
    this.value = path;
    this.updateTriggerLabel();
    this.onChange(path);
    this.closePopover();
  }

  private closePopover(): void {
    if (this.closeHandler) {
      window.activeDocument.removeEventListener('click', this.closeHandler, true);
      this.closeHandler = null;
    }
    this.popoverEl?.remove();
    this.popoverEl = null;
    this.listEl = null;
    this.filterEl = null;
  }
}

export function listVaultFolders(app: App): string[] {
  return app.vault
    .getAllFolders()
    .map((f) => f.path)
    .filter((p) => p.length > 0)
    .sort((a, b) => a.localeCompare(b));
}
