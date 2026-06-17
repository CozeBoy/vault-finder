import { Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { I18nStrings } from '../i18n';
import { attachInternalLinkHandler } from './vaultLink';

export interface ArticleEditorPanelCallbacks {
  getStrings: () => I18nStrings;
  onSave: (markdown: string) => void;
  onCancel: () => void;
}

export class ArticleEditorPanel {
  private rootEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private markdownModeBtn: HTMLButtonElement | null = null;
  private draft = '';
  private markdownMode = true;

  constructor(
    private app: App,
    private owner: Component,
    private callbacks: ArticleEditorPanelCallbacks,
  ) {}

  mount(parent: HTMLElement, before?: HTMLElement | null): void {
    const root = parent.createDiv({ cls: 'vault-finder-article-editor-panel is-hidden' });
    if (before) {
      parent.insertBefore(root, before);
    }
    this.rootEl = root;

    const t = this.callbacks.getStrings();
    const toolbar = root.createDiv({ cls: 'vault-finder-article-editor-toolbar' });
    toolbar.createSpan({ cls: 'vault-finder-article-editor-title', text: t.viewArticleEditPanelTitle });

    const actions = toolbar.createDiv({ cls: 'vault-finder-article-editor-actions' });

    this.markdownModeBtn = actions.createEl('button', {
      cls: 'vault-finder-article-editor-mode-btn',
      type: 'button',
    });
    this.markdownModeBtn.addEventListener('click', () => void this.toggleMarkdownMode());

    const cancelBtn = actions.createEl('button', {
      cls: 'vault-finder-article-editor-cancel',
      text: t.viewArticleEditCancel,
      type: 'button',
    });
    cancelBtn.addEventListener('click', () => this.callbacks.onCancel());

    const saveBtn = actions.createEl('button', {
      cls: 'mod-cta vault-finder-article-editor-save',
      text: t.viewArticleEditSave,
      type: 'button',
    });
    saveBtn.addEventListener('click', () => {
      this.syncDraftFromEditor();
      this.callbacks.onSave(this.draft);
    });

    const scroll = root.createDiv({ cls: 'vault-finder-article-editor-scroll' });
    this.bodyEl = scroll.createDiv({ cls: 'vault-finder-article-editor-body' });
    this.updateModeButton();
  }

  destroy(): void {
    this.rootEl?.remove();
    this.rootEl = null;
    this.bodyEl = null;
    this.textareaEl = null;
    this.previewEl = null;
    this.markdownModeBtn = null;
  }

  isOpen(): boolean {
    return this.rootEl !== null && !this.rootEl.hasClass('is-hidden');
  }

  open(markdown: string): void {
    if (!this.rootEl || !this.bodyEl) return;
    this.draft = markdown;
    this.markdownMode = true;
    this.rootEl.removeClass('is-hidden');
    void this.renderBody();
    window.requestAnimationFrame(() => {
      this.textareaEl?.focus();
      if (this.textareaEl) {
        this.textareaEl.setSelectionRange(this.textareaEl.value.length, this.textareaEl.value.length);
      }
    });
  }

  close(): void {
    this.rootEl?.addClass('is-hidden');
    this.bodyEl?.empty();
    this.textareaEl = null;
    this.previewEl = null;
  }

  applyLocale(): void {
    const t = this.callbacks.getStrings();
    const title = this.rootEl?.querySelector('.vault-finder-article-editor-title');
    title?.setText(t.viewArticleEditPanelTitle);
    const cancelBtn = this.rootEl?.querySelector('.vault-finder-article-editor-cancel');
    if (cancelBtn) cancelBtn.setText(t.viewArticleEditCancel);
    const saveBtn = this.rootEl?.querySelector('.vault-finder-article-editor-save');
    if (saveBtn) saveBtn.setText(t.viewArticleEditSave);
    this.updateModeButton();
  }

  private syncDraftFromEditor(): void {
    if (this.markdownMode && this.textareaEl) {
      this.draft = this.textareaEl.value;
    }
  }

  private async toggleMarkdownMode(): Promise<void> {
    this.syncDraftFromEditor();
    this.markdownMode = !this.markdownMode;
    this.updateModeButton();
    await this.renderBody();
    if (this.markdownMode) {
      this.textareaEl?.focus();
    }
  }

  private updateModeButton(): void {
    if (!this.markdownModeBtn) return;
    const t = this.callbacks.getStrings();
    this.markdownModeBtn.empty();
    const inner = this.markdownModeBtn.createSpan({ cls: 'vault-finder-article-editor-mode-inner' });
    if (this.markdownMode) {
      setIcon(inner.createSpan(), 'eye');
      inner.createSpan({ text: t.viewArticleEditPreview });
      this.markdownModeBtn.setAttr('aria-label', t.viewArticleEditPreview);
      this.markdownModeBtn.setAttr('title', t.viewArticleEditPreview);
    } else {
      setIcon(inner.createSpan(), 'code');
      inner.createSpan({ text: t.viewArticleEditMarkdown });
      this.markdownModeBtn.setAttr('aria-label', t.viewArticleEditMarkdown);
      this.markdownModeBtn.setAttr('title', t.viewArticleEditMarkdown);
    }
  }

  private async renderBody(): Promise<void> {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.textareaEl = null;
    this.previewEl = null;

    if (this.markdownMode) {
      this.textareaEl = this.bodyEl.createEl('textarea', {
        cls: 'vault-finder-article-editor-input',
        text: this.draft,
      });
      return;
    }

    this.previewEl = this.bodyEl.createEl('div', {
      cls: 'vault-finder-article-editor-preview markdown-rendered',
    });
    await MarkdownRenderer.render(this.app, this.draft, this.previewEl, '', this.owner);
    attachInternalLinkHandler(this.previewEl, this.app, (el, type, handler) => {
      this.owner.registerDomEvent(el, type, handler);
    });
  }
}
