import { App, Modal, Setting } from 'obsidian';
import type { I18nStrings } from '../i18n';
import {
  ARTICLE_OPTIMIZE_SHORTCUTS_MAX,
  createOptimizeShortcutId,
  type ArticleOptimizeShortcut,
} from '../settings';

export class OptimizeShortcutManageModal extends Modal {
  private draft: ArticleOptimizeShortcut[];

  constructor(
    app: App,
    private labels: I18nStrings,
    shortcuts: ArticleOptimizeShortcut[],
    private onSave: (shortcuts: ArticleOptimizeShortcut[]) => void,
  ) {
    super(app);
    this.draft = shortcuts.map((item) => ({ ...item }));
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.labels.viewOptimizeShortcutsManage);
    contentEl.addClass('vault-finder-optimize-shortcut-modal');
    this.render();
  }

  private render(): void {
    this.contentEl.empty();

    if (this.draft.length === 0) {
      this.contentEl.createEl('div', {
        cls: 'vault-finder-empty',
        text: this.labels.viewOptimizeShortcutsEmpty,
      });
    }

    for (let index = 0; index < this.draft.length; index++) {
      const item = this.draft[index];
      if (!item) continue;
      const card = this.contentEl.createDiv({ cls: 'vault-finder-optimize-shortcut-card' });

      new Setting(card)
        .setName(this.labels.viewOptimizeShortcutLabel)
        .addText((text) => {
          text.setValue(item.label).onChange((value) => {
            item.label = value;
          });
        })
        .addButton((btn) => {
          btn
            .setButtonText(this.labels.viewOptimizeShortcutDelete)
            .setWarning()
            .onClick(() => {
              this.draft.splice(index, 1);
              this.render();
            });
        });

      new Setting(card).setName(this.labels.viewOptimizeShortcutText).addTextArea((area) => {
        area.setValue(item.text).onChange((value) => {
          item.text = value;
        });
        area.inputEl.rows = 3;
      });
    }

    const actions = this.contentEl.createDiv({ cls: 'vault-finder-optimize-shortcut-modal-actions' });

    if (this.draft.length < ARTICLE_OPTIMIZE_SHORTCUTS_MAX) {
      actions.createEl('button', {
        cls: 'vault-finder-optimize-shortcut-add',
        text: this.labels.viewOptimizeShortcutAdd,
        type: 'button',
      }).addEventListener('click', () => {
        this.draft.push({
          id: createOptimizeShortcutId(),
          label: this.labels.viewOptimizeShortcutNewLabel,
          text: '',
        });
        this.render();
      });
    }

    actions.createEl('button', {
      cls: 'mod-cta',
      text: this.labels.viewOptimizeShortcutSave,
      type: 'button',
    }).addEventListener('click', () => {
      const normalized = this.draft
        .map((item) => ({
          id: item.id.trim() || createOptimizeShortcutId(),
          label: item.label.trim(),
          text: item.text.trim(),
        }))
        .filter((item) => item.label && item.text);
      this.onSave(normalized);
      this.close();
    });

    actions.createEl('button', {
      text: this.labels.viewArticleEditCancel,
      type: 'button',
    }).addEventListener('click', () => this.close());
  }
}
