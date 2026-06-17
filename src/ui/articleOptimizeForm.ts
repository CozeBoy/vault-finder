import { setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { allModelsForProvider } from '../ai/models';
import type { I18nStrings } from '../i18n';
import { AI_PROVIDERS, type AiProvider, type ArticleOptimizeShortcut, type VaultFinderSettings } from '../settings';
import { defaultModelForProvider } from '../settings';
import { OptimizeShortcutManageModal } from './optimizeShortcutModal';

export interface ArticleOptimizeFormCallbacks {
  app: App;
  getStrings: () => I18nStrings;
  getSettings: () => VaultFinderSettings;
  getShortcuts: () => ArticleOptimizeShortcut[];
  onShortcutsChange: (shortcuts: ArticleOptimizeShortcut[]) => Promise<void>;
  onSubmit: (instruction: string, provider: AiProvider, model: string) => Promise<void>;
}

/** Provider / model / instruction fields for the footer optimize chat tab. */
export class ArticleOptimizeForm {
  private rootEl: HTMLElement | null = null;
  private shortcutSelectEl: HTMLSelectElement | null = null;
  private providerSelectEl: HTMLSelectElement | null = null;
  private modelSelectEl: HTMLSelectElement | null = null;
  private instructionEl: HTMLTextAreaElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private running = false;

  constructor(private callbacks: ArticleOptimizeFormCallbacks) {}

  mount(parent: HTMLElement): void {
    const t = this.callbacks.getStrings();
    const root = parent.createDiv({ cls: 'vault-finder-optimize-form' });
    this.rootEl = root;

    const controls = root.createDiv({ cls: 'vault-finder-optimize-controls' });

    const providerWrap = controls.createDiv({ cls: 'vault-finder-control' });
    providerWrap.createSpan({ cls: 'vault-finder-label', text: t.viewAiProvider });
    this.providerSelectEl = providerWrap.createEl('select', { cls: 'dropdown vault-finder-select' });
    for (const provider of AI_PROVIDERS) {
      this.providerSelectEl.createEl('option', {
        value: provider,
        text: t.aiProviderLabel(provider),
      });
    }
    this.providerSelectEl.value = this.callbacks.getSettings().aiProvider;
    this.providerSelectEl.addEventListener('change', () => this.refreshModelSelect());

    const modelWrap = controls.createDiv({ cls: 'vault-finder-control vault-finder-control-wide' });
    modelWrap.createSpan({ cls: 'vault-finder-label', text: t.viewAiModel });
    this.modelSelectEl = modelWrap.createEl('select', { cls: 'dropdown vault-finder-select' });
    this.refreshModelSelect();

    const shortcutWrap = controls.createDiv({
      cls: 'vault-finder-control vault-finder-control-wide vault-finder-optimize-shortcut-control',
    });
    shortcutWrap.createSpan({ cls: 'vault-finder-label', text: t.viewOptimizeShortcuts });
    const shortcutRow = shortcutWrap.createDiv({ cls: 'vault-finder-optimize-shortcut-row' });
    this.shortcutSelectEl = shortcutRow.createEl('select', {
      cls: 'dropdown vault-finder-select vault-finder-optimize-shortcut-select',
    });
    this.shortcutSelectEl.addEventListener('change', () => this.onShortcutSelect());
    const manageBtn = shortcutRow.createEl('button', {
      cls: 'vault-finder-icon-btn vault-finder-optimize-shortcut-manage',
      type: 'button',
      attr: { 'aria-label': t.viewOptimizeShortcutsManage, title: t.viewOptimizeShortcutsManage },
    });
    setIcon(manageBtn.createSpan(), 'settings');
    manageBtn.addEventListener('click', () => this.openManageModal());
    this.renderShortcutSelect();

    const inputWrap = root.createDiv({ cls: 'vault-finder-input-wrap' });
    this.instructionEl = inputWrap.createEl('textarea', {
      cls: 'vault-finder-input vault-finder-optimize-input',
      attr: { placeholder: t.viewOptimizePlaceholder, rows: '2' },
    });

    this.submitBtn = inputWrap.createEl('button', {
      cls: 'mod-cta vault-finder-send vault-finder-send-icon vault-finder-optimize-submit',
      type: 'button',
    });
    const submitIcon = this.submitBtn.createSpan({ cls: 'vault-finder-send-icon-inner' });
    setIcon(submitIcon, 'sparkles');
    this.submitBtn.setAttribute('aria-label', t.viewOptimizeSubmit);

    this.submitBtn.addEventListener('click', () => void this.handleSubmit());
    this.instructionEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        void this.handleSubmit();
      }
    });
  }

  destroy(): void {
    this.rootEl?.remove();
    this.rootEl = null;
    this.shortcutSelectEl = null;
    this.instructionEl = null;
    this.submitBtn = null;
  }

  focusInput(): void {
    this.instructionEl?.focus();
  }

  refreshShortcuts(): void {
    this.renderShortcutSelect();
  }

  applyLocale(): void {
    const t = this.callbacks.getStrings();
    this.instructionEl?.setAttr('placeholder', t.viewOptimizePlaceholder);
    this.submitBtn?.setAttribute('aria-label', t.viewOptimizeSubmit);
    const manageBtn = this.rootEl?.querySelector('.vault-finder-optimize-shortcut-manage');
    manageBtn?.setAttr('aria-label', t.viewOptimizeShortcutsManage);
    manageBtn?.setAttr('title', t.viewOptimizeShortcutsManage);
    const label = this.rootEl?.querySelector('.vault-finder-optimize-shortcut-control > .vault-finder-label');
    label?.setText(t.viewOptimizeShortcuts);
    this.renderShortcutSelect();
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (this.submitBtn) {
      this.submitBtn.disabled = running;
      this.submitBtn.toggleClass('is-busy', running);
    }
    this.instructionEl?.toggleClass('is-busy', running);
  }

  private renderShortcutSelect(): void {
    if (!this.shortcutSelectEl) return;
    const t = this.callbacks.getStrings();
    const shortcuts = this.callbacks.getShortcuts();
    this.shortcutSelectEl.empty();

    const placeholder = this.shortcutSelectEl.createEl('option', {
      value: '',
      text: shortcuts.length === 0
        ? t.viewOptimizeShortcutsEmpty
        : t.viewOptimizeShortcutSelectPlaceholder,
    });
    placeholder.disabled = true;
    placeholder.selected = true;

    for (const shortcut of shortcuts) {
      const option = this.shortcutSelectEl.createEl('option', {
        value: shortcut.id,
        text: shortcut.label,
      });
      option.title = shortcut.text;
    }

    this.shortcutSelectEl.disabled = shortcuts.length === 0;
  }

  private onShortcutSelect(): void {
    if (!this.shortcutSelectEl) return;
    const id = this.shortcutSelectEl.value;
    if (!id) return;
    const shortcut = this.callbacks.getShortcuts().find((item) => item.id === id);
    if (shortcut) {
      this.applyShortcut(shortcut.text);
    }
    this.shortcutSelectEl.value = '';
  }

  private applyShortcut(text: string): void {
    if (!this.instructionEl) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = this.instructionEl.value.trim();
    this.instructionEl.value = current ? `${current}\n\n${trimmed}` : trimmed;
    this.instructionEl.focus();
  }

  private openManageModal(): void {
    new OptimizeShortcutManageModal(
      this.callbacks.app,
      this.callbacks.getStrings(),
      this.callbacks.getShortcuts(),
      (shortcuts) => {
        void this.callbacks.onShortcutsChange(shortcuts).then(() => {
          this.renderShortcutSelect();
        });
      },
    ).open();
  }

  private refreshModelSelect(): void {
    if (!this.providerSelectEl || !this.modelSelectEl) return;
    const settings = this.callbacks.getSettings();
    const provider = this.providerSelectEl.value as AiProvider;
    const models = allModelsForProvider(provider, settings);
    const current = this.modelSelectEl.value;
    this.modelSelectEl.empty();
    for (const model of models) {
      this.modelSelectEl.createEl('option', { value: model, text: model });
    }
    const fallback = models.includes(settings.aiModel)
      ? settings.aiModel
      : (models[0] ?? defaultModelForProvider(provider));
    this.modelSelectEl.value = models.includes(current) ? current : fallback;
  }

  private async handleSubmit(): Promise<void> {
    if (this.running || !this.instructionEl || !this.providerSelectEl || !this.modelSelectEl) return;
    const instruction = this.instructionEl.value.trim();
    if (!instruction) return;
    const provider = this.providerSelectEl.value as AiProvider;
    const model = this.modelSelectEl.value.trim();
    if (!model) return;
    await this.callbacks.onSubmit(instruction, provider, model);
  }
}
