import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { allModelsForProvider } from '../ai/models';
import type VaultFinderPlugin from '../main';
import { clampMatchThreshold } from '../index/matchScore';
import { AI_PROVIDERS, type AiProvider, defaultModelForProvider, hasValidAiKey, isAiActive } from '../settings';
import { SearchController } from './searchController';
import type { SearchHistoryEntry } from './searchHistory';
import type { SearchHit } from '../index/types';
import { ScopePicker, listVaultFolders } from './scopePicker';
import { attachInternalLinkHandler, openVaultLink } from './vaultLink';
import { FolderPickerModal, makeFolderPickerLabels } from './folderPickerModal';
import { buildArticleFilename, saveMarkdownToFolder } from './articleSave';
import { exportArticleToDisk, type ArticleExportFormat } from './articleExport';
import type { I18nStrings } from '../i18n';
import { rememberArticleSaveFolder } from '../settings';
import { copyTextForArticle, stripSourceWikilinks } from '../utils/articleMarkdown';
import { aiErrorNotice } from '../ai/apiErrors';
import { ArticleOptimizeForm } from './articleOptimizeForm';
import { ArticleEditorPanel } from './articleEditorPanel';

export const VAULT_FINDER_VIEW_TYPE = 'vault-finder-search';

type PanelTab = 'current' | 'history';
type HistoryView = 'list' | 'detail';

type FooterChatTab = 'search' | 'optimize';

export class SearchView extends ItemView {
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private sendBtnIconEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private articleEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private scopePicker!: ScopePicker;
  private controller!: SearchController;
  private currentPanelEl!: HTMLElement;
  private historyPanelEl!: HTMLElement;
  private historyListEl!: HTMLElement;
  private historyDetailEl!: HTMLElement;
  private providerLabelEl!: HTMLElement;
  private modelLabelEl!: HTMLElement;
  private thresholdLabelEl!: HTMLElement;
  private tabCurrentBtn!: HTMLButtonElement;
  private tabHistoryBtn!: HTMLButtonElement;
  private footerEl!: HTMLElement;
  private activeTab: PanelTab = 'current';
  private historyView: HistoryView = 'list';
  private viewingHistoryEntry: SearchHistoryEntry | null = null;
  private showArticleSources = true;
  private articleEditing = false;
  private articleVersions: string[] = [];
  private articleVersionIndex = 0;
  private optimizeForm: ArticleOptimizeForm | null = null;
  private searchChatTabBtn!: HTMLButtonElement;
  private optimizeChatTabBtn!: HTMLButtonElement;
  private searchChatPane!: HTMLElement;
  private optimizeChatPane!: HTMLElement;
  private footerChatTab: FooterChatTab = 'search';
  private articleEditorPanel: ArticleEditorPanel | null = null;
  private historyArticleEditor: ArticleEditorPanel | null = null;
  private activeArticleHost: HTMLElement | null = null;
  private articleVersionNavState: {
    versionLayer: HTMLElement;
    prevBtn: HTMLButtonElement;
    nextBtn: HTMLButtonElement;
    versionLabel: HTMLElement;
  } | null = null;
  private readonly boundResize = (): void => {
    this.updateFooterInset();
  };

  constructor(leaf: WorkspaceLeaf, private plugin: VaultFinderPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VAULT_FINDER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.t().viewTitle;
  }

  getIcon(): string {
    return 'search';
  }

  async onOpen(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('vault-finder-view');

    const t = this.plugin.t();

    const tabsEl = containerEl.createEl('div', { cls: 'vault-finder-tabs' });
    this.tabCurrentBtn = tabsEl.createEl('button', {
      cls: 'vault-finder-tab is-active',
      text: t.viewTabCurrent,
      type: 'button',
    });
    this.tabHistoryBtn = tabsEl.createEl('button', {
      cls: 'vault-finder-tab',
      text: t.viewTabHistory,
      type: 'button',
    });

    this.currentPanelEl = containerEl.createEl('div', { cls: 'vault-finder-panel vault-finder-panel-current' });
    const content = this.currentPanelEl.createEl('div', { cls: 'vault-finder-content' });
    this.statusEl = content.createEl('div', { cls: 'vault-finder-status' });
    this.articleEl = content.createEl('div', { cls: 'vault-finder-article' });
    this.resultsEl = content.createEl('div', { cls: 'vault-finder-results' });

    const footer = this.currentPanelEl.createEl('div', { cls: 'vault-finder-footer' });
    this.footerEl = footer;

    this.articleEditorPanel = new ArticleEditorPanel(this.app, this, {
      getStrings: () => this.plugin.t(),
      onSave: (markdown) => void this.closeArticleEditor(true, markdown),
      onCancel: () => void this.closeArticleEditor(false),
    });
    this.articleEditorPanel.mount(this.currentPanelEl, footer);

    const chatTabs = footer.createDiv({ cls: 'vault-finder-footer-chat-tabs' });
    this.searchChatTabBtn = chatTabs.createEl('button', {
      cls: 'vault-finder-footer-chat-tab is-active',
      text: t.viewChatTabSearch,
      type: 'button',
    });
    this.optimizeChatTabBtn = chatTabs.createEl('button', {
      cls: 'vault-finder-footer-chat-tab',
      text: t.viewChatTabOptimize,
      type: 'button',
    });
    this.searchChatTabBtn.addEventListener('click', () => this.switchFooterChatTab('search'));
    this.optimizeChatTabBtn.addEventListener('click', () => this.switchFooterChatTab('optimize'));

    this.searchChatPane = footer.createDiv({
      cls: 'vault-finder-footer-chat-pane vault-finder-footer-chat-pane-search is-active',
    });
    const controls = this.searchChatPane.createEl('div', { cls: 'vault-finder-footer-controls' });

    this.buildProviderSelect(controls, t);
    this.buildModelSelect(controls, t);
    this.buildScopeSelect(controls, t);
    this.buildMatchThresholdControl(controls, t);

    const inputWrap = this.searchChatPane.createEl('div', { cls: 'vault-finder-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'vault-finder-input',
      attr: { placeholder: t.searchPlaceholder, rows: '2' },
    });

    this.sendBtn = inputWrap.createEl('button', {
      cls: 'mod-cta vault-finder-send vault-finder-send-icon',
      type: 'button',
    });
    this.sendBtnIconEl = this.sendBtn.createSpan({ cls: 'vault-finder-send-icon-inner' });
    this.setSendButtonMode('search');
    this.sendBtn.setAttribute('aria-label', t.viewSearchButton);

    this.optimizeChatPane = footer.createDiv({
      cls: 'vault-finder-footer-chat-pane vault-finder-footer-chat-pane-optimize',
    });
    this.optimizeForm = new ArticleOptimizeForm({
      app: this.app,
      getStrings: () => this.plugin.t(),
      getSettings: () => this.plugin.settings,
      getShortcuts: () => this.plugin.settings.articleOptimizeShortcuts,
      onShortcutsChange: async (shortcuts) => {
        this.plugin.settings.articleOptimizeShortcuts = shortcuts;
        await this.plugin.saveSettings();
      },
      onSubmit: (instruction, provider, model) =>
        this.runArticleOptimize(instruction, provider, model),
    });
    this.optimizeForm.mount(this.optimizeChatPane);

    this.historyPanelEl = containerEl.createEl('div', {
      cls: 'vault-finder-panel vault-finder-panel-history is-hidden',
    });
    this.historyListEl = this.historyPanelEl.createEl('div', { cls: 'vault-finder-history-list' });
    this.historyDetailEl = this.historyPanelEl.createEl('div', {
      cls: 'vault-finder-history-detail is-hidden',
    });

    this.controller = new SearchController(this.plugin, {
      getQuery: () => this.inputEl.value,
      getSearchScope: () => this.scopePicker.getValue(),
      onStatusChange: () => this.updateStatus(),
      onHitsChange: () => this.renderResults(),
      onArticleChange: (markdown, loading) => {
        if (loading) {
          this.resetArticlePresentationState();
          void this.renderArticle(null, true);
          return;
        }
        if (markdown?.trim()) {
          this.articleVersions = [markdown];
          this.articleVersionIndex = 0;
        }
        void this.renderArticle(markdown, false);
      },
      onSearchingChange: (searching) => this.updateSendButton(searching),
      onHistoryChange: () => this.refreshHistoryList(),
    });

    this.inputEl.focus();
    this.updateStatus();
    this.renderHistoryList();
    this.updateFooterInset();
    window.addEventListener('resize', this.boundResize);

    this.sendBtn.addEventListener('click', () => {
      if (this.controller.isSearching) {
        this.controller.cancelSearch();
      } else {
        void this.controller.submitSearch();
      }
    });

    this.inputEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        if (this.controller.isSearching) {
          this.controller.cancelSearch();
        } else {
          void this.controller.submitSearch();
        }
      } else if (evt.key === 'ArrowDown' && evt.metaKey === false && evt.ctrlKey === false) {
        if (window.activeDocument.activeElement === this.inputEl && this.controller.allHits().length > 0) {
          evt.preventDefault();
          this.controller.moveSelection(1);
          this.scrollToSelected();
        }
      }
    });

    this.tabCurrentBtn.addEventListener('click', () => this.switchTab('current'));
    this.tabHistoryBtn.addEventListener('click', () => this.switchTab('history'));
    this.setupArticleSaveContextMenus();
    this.updateViewHeaderTitle();
  }

  async onClose(): Promise<void> {
    window.removeEventListener('resize', this.boundResize);
    this.controller.dispose();
    this.scopePicker.destroy();
    this.optimizeForm?.destroy();
    this.optimizeForm = null;
    this.articleEditorPanel?.destroy();
    this.articleEditorPanel = null;
    this.historyArticleEditor?.destroy();
    this.historyArticleEditor = null;
    this.articleVersionNavState = null;
    this.containerEl.empty();
  }

  focusSearchInput(): void {
    this.switchTab('current');
    this.inputEl?.focus();
  }

  applyLocale(): void {
    if (!this.inputEl) return;
    const t = this.plugin.t();

    this.tabCurrentBtn.setText(t.viewTabCurrent);
    this.tabHistoryBtn.setText(t.viewTabHistory);
    this.inputEl.setAttr('placeholder', t.searchPlaceholder);
    this.setSendButtonMode(this.controller.isSearching ? 'stop' : 'search');

    this.providerLabelEl.setText(t.viewAiProvider);
    this.modelLabelEl.setText(t.viewAiModel);
    this.thresholdLabelEl.setText(t.viewMatchThreshold);
    this.scopePicker.updateLocale({
      label: t.viewSearchScope,
      entireVaultLabel: t.viewScopeEntireVault,
      filterPlaceholder: t.viewScopeFilterPlaceholder,
    });

    this.articleEl.setAttr('title', t.viewArticleSaveHint);
    this.optimizeForm?.applyLocale();
    this.searchChatTabBtn.setText(t.viewChatTabSearch);
    this.optimizeChatTabBtn.setText(t.viewChatTabOptimize);
    this.articleEditorPanel?.applyLocale();
    this.historyArticleEditor?.applyLocale();
    this.updateViewHeaderTitle();
    this.updateStatus();
    this.renderResults();

    if (this.activeTab === 'history') {
      if (this.historyView === 'list') {
        this.renderHistoryList();
      } else if (this.viewingHistoryEntry) {
        this.openHistoryEntry(this.viewingHistoryEntry);
      }
    }
  }

  private updateViewHeaderTitle(): void {
    const title = this.getDisplayText();
    const headerTitle = this.containerEl
      .closest('.workspace-leaf')
      ?.querySelector('.view-header-title');
    if (headerTitle) headerTitle.setText(title);
  }

  refreshModelSelect(): void {
    if (!this.modelSelectEl) return;
    const current = this.plugin.settings.aiModel;
    this.modelSelectEl.empty();
    for (const model of allModelsForProvider(this.plugin.settings.aiProvider, this.plugin.settings)) {
      this.modelSelectEl.createEl('option', { value: model, text: model });
    }
    const models = allModelsForProvider(this.plugin.settings.aiProvider, this.plugin.settings);
    this.modelSelectEl.value = models.includes(current) ? current : (models[0] ?? current);
  }

  refreshHistoryList(): void {
    this.renderHistoryList();
  }

  private switchFooterChatTab(tab: FooterChatTab): void {
    this.footerChatTab = tab;
    this.searchChatTabBtn.toggleClass('is-active', tab === 'search');
    this.optimizeChatTabBtn.toggleClass('is-active', tab === 'optimize');
    this.searchChatPane.toggleClass('is-active', tab === 'search');
    this.optimizeChatPane.toggleClass('is-active', tab === 'optimize');
    if (tab === 'search') {
      this.inputEl.focus();
    } else {
      this.optimizeForm?.focusInput();
    }
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.switchFooterChatTab('search');
    void this.closeArticleEditor(false);
    this.tabCurrentBtn.toggleClass('is-active', tab === 'current');
    this.tabHistoryBtn.toggleClass('is-active', tab === 'history');
    this.currentPanelEl.toggleClass('is-hidden', tab !== 'current');
    this.historyPanelEl.toggleClass('is-hidden', tab !== 'history');
    if (tab === 'history') {
      this.historyView = 'list';
      this.viewingHistoryEntry = null;
      this.renderHistoryList();
    }
    this.updateFooterInset();
  }

  private setSendButtonMode(mode: 'search' | 'stop'): void {
    const t = this.plugin.t();
    setIcon(this.sendBtnIconEl, mode === 'stop' ? 'square' : 'search');
    this.sendBtn.setAttribute(
      'aria-label',
      mode === 'stop' ? t.viewStopSearchButton : t.viewSearchButton,
    );
    this.sendBtn.toggleClass('is-stop', mode === 'stop');
  }

  private updateSendButton(searching: boolean): void {
    this.setSendButtonMode(searching ? 'stop' : 'search');
    this.inputEl.toggleClass('is-searching', searching);
  }

  private updateFooterInset(): void {
    const footer = this.currentPanelEl?.querySelector('.vault-finder-footer');
    if (!(footer instanceof HTMLElement)) return;
    const statusBar = window.activeDocument.querySelector('.status-bar');
    const inset = statusBar instanceof HTMLElement ? statusBar.offsetHeight : 22;
    footer.style.setProperty('--vault-finder-footer-inset', `${inset}px`);
  }

  private buildProviderSelect(parent: HTMLElement, t: ReturnType<VaultFinderPlugin['t']>): void {
    const wrap = parent.createEl('div', { cls: 'vault-finder-control' });
    this.providerLabelEl = wrap.createEl('span', { text: t.viewAiProvider, cls: 'vault-finder-label' });
    const select = wrap.createEl('select', { cls: 'dropdown vault-finder-select' });
    for (const provider of AI_PROVIDERS) {
      select.createEl('option', { value: provider, text: t.aiProviderLabel(provider) });
    }
    select.value = this.plugin.settings.aiProvider;
    select.addEventListener('change', () => {
      void this.onProviderChange(select.value as AiProvider);
    });
  }

  private buildModelSelect(parent: HTMLElement, t: ReturnType<VaultFinderPlugin['t']>): void {
    const wrap = parent.createEl('div', { cls: 'vault-finder-control vault-finder-control-wide' });
    this.modelLabelEl = wrap.createEl('span', { text: t.viewAiModel, cls: 'vault-finder-label' });
    this.modelSelectEl = wrap.createEl('select', { cls: 'dropdown vault-finder-select' });
    this.refreshModelSelect();
    this.modelSelectEl.addEventListener('change', () => {
      void this.onModelChange(this.modelSelectEl.value);
    });
  }

  private buildScopeSelect(parent: HTMLElement, t: ReturnType<VaultFinderPlugin['t']>): void {
    const wrap = parent.createEl('div', { cls: 'vault-finder-control vault-finder-control-scope' });
    this.scopePicker = new ScopePicker(wrap, {
      label: t.viewSearchScope,
      entireVaultLabel: t.viewScopeEntireVault,
      filterPlaceholder: t.viewScopeFilterPlaceholder,
      value: '',
      folders: listVaultFolders(this.app),
      onChange: () => {
        this.updateStatus();
      },
    });
  }

  private buildMatchThresholdControl(
    parent: HTMLElement,
    t: ReturnType<VaultFinderPlugin['t']>,
  ): void {
    const wrap = parent.createEl('div', { cls: 'vault-finder-control vault-finder-control-threshold' });
    const labelRow = wrap.createEl('div', { cls: 'vault-finder-threshold-label-row' });
    this.thresholdLabelEl = labelRow.createEl('span', { text: t.viewMatchThreshold, cls: 'vault-finder-label' });
    const valueEl = labelRow.createEl('span', {
      cls: 'vault-finder-threshold-value',
      text: `${this.plugin.settings.searchMatchThreshold}%`,
    });

    const slider = wrap.createEl('input', {
      cls: 'vault-finder-threshold-slider',
      attr: {
        type: 'range',
        min: '1',
        max: '100',
        step: '1',
      },
    });
    if (!slider.instanceOf(HTMLInputElement)) return;
    slider.value = String(this.plugin.settings.searchMatchThreshold);

    slider.addEventListener('input', () => {
      const value = clampMatchThreshold(Number.parseInt(slider.value, 10));
      valueEl.setText(`${value}%`);
    });

    slider.addEventListener('change', () => {
      const value = clampMatchThreshold(Number.parseInt(slider.value, 10));
      this.plugin.settings.searchMatchThreshold = value;
      slider.value = String(value);
      valueEl.setText(`${value}%`);
      void this.plugin.saveSettings();
      if (this.inputEl.value.trim() && this.controller.allHits().length > 0) {
        const all = [...this.controller.primaryHits, ...this.controller.weakHits];
        this.controller.applyMatchSplit(all);
        this.renderResults();
        this.updateStatus();
      }
    });
  }

  private async onProviderChange(provider: AiProvider): Promise<void> {
    this.plugin.settings.aiProvider = provider;
    const models = allModelsForProvider(provider, this.plugin.settings);
    if (!models.includes(this.plugin.settings.aiModel)) {
      this.plugin.settings.aiModel = models[0] ?? defaultModelForProvider(provider);
    }
    await this.plugin.saveSettings();
    this.refreshModelSelect();
  }

  private async onModelChange(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) return;
    this.plugin.settings.aiModel = trimmed;
    await this.plugin.saveSettings();
  }

  private resetArticlePresentationState(): void {
    this.showArticleSources = true;
    this.articleEditing = false;
    this.articleVersions = [];
    this.articleVersionIndex = 0;
    this.activeArticleHost = null;
    this.articleVersionNavState = null;
    this.optimizeForm?.setRunning(false);
    this.switchFooterChatTab('search');
    this.articleEditorPanel?.close();
    this.historyArticleEditor?.close();
    this.setArticleEditLayout(false);
  }

  private getDisplayMarkdown(markdown: string): string {
    return this.showArticleSources ? markdown : stripSourceWikilinks(markdown);
  }

  private getCurrentArticleMarkdown(): string {
    if (this.articleVersions.length > 0) {
      const index = Math.min(
        Math.max(this.articleVersionIndex, 0),
        this.articleVersions.length - 1,
      );
      const version = this.articleVersions[index]?.trim();
      if (version) return version;
    }
    return this.controller.article?.trim() ?? this.viewingHistoryEntry?.article?.trim() ?? '';
  }

  private syncControllerToCurrentVersion(): void {
    const markdown = this.getCurrentArticleMarkdown();
    if (!markdown) return;
    this.controller.article = markdown;
    if (this.viewingHistoryEntry) {
      this.viewingHistoryEntry.article = markdown;
    }
  }

  private setCurrentArticleMarkdown(markdown: string, options?: { appendVersion?: boolean }): void {
    const trimmed = markdown.trim();
    if (!trimmed) return;

    if (options?.appendVersion) {
      const displayed = this.getCurrentArticleMarkdown();
      if (this.articleVersions.length === 0) {
        this.articleVersions =
          displayed && displayed !== trimmed ? [displayed, trimmed] : [trimmed];
      } else {
        this.articleVersions = [...this.articleVersions, trimmed];
      }
      this.articleVersionIndex = this.articleVersions.length - 1;
    } else if (this.articleVersions.length > 0) {
      const index = Math.min(
        Math.max(this.articleVersionIndex, 0),
        this.articleVersions.length - 1,
      );
      this.articleVersions[index] = trimmed;
      this.articleVersionIndex = index;
    } else {
      this.articleVersions = [trimmed];
      this.articleVersionIndex = 0;
    }

    this.syncControllerToCurrentVersion();
  }

  private async renderArticle(markdown: string | null, loading: boolean): Promise<void> {
    const targetArticleEl = this.activeTab === 'history' ? this.getHistoryArticleEl() : this.articleEl;
    if (!targetArticleEl) return;

    targetArticleEl.empty();
    this.activeArticleHost = null;
    this.articleVersionNavState = null;

    if (loading) {
      const loadingEl = targetArticleEl.createEl('div', {
        cls: 'vault-finder-article-loading',
        attr: { 'aria-label': this.plugin.t().searchPhaseAiArticle },
      });
      setIcon(loadingEl.createSpan({ cls: 'vault-finder-article-loading-icon' }), 'loader-2');
      return;
    }

    const content = markdown?.trim() ?? this.getCurrentArticleMarkdown();
    if (!content) return;

    targetArticleEl.setAttr('title', this.plugin.t().viewArticleSaveHint);
    await this.renderArticleChrome(targetArticleEl, content);
    this.renderResults();
  }

  private async renderArticleChrome(host: HTMLElement, markdown: string): Promise<void> {
    this.activeArticleHost = host;
    host.empty();

    const t = this.plugin.t();
    const toolbar = host.createDiv({ cls: 'vault-finder-article-toolbar' });
    toolbar.createSpan({ cls: 'vault-finder-article-toolbar-title', text: t.viewArticleHeading });

    const actions = toolbar.createDiv({ cls: 'vault-finder-article-toolbar-actions' });
    this.createToolbarIconButton(
      actions,
      this.showArticleSources ? 'eye' : 'eye-off',
      this.showArticleSources ? t.viewToggleSourcesHide : t.viewToggleSourcesShow,
      () => this.toggleArticleSourceVisibility(),
    );
    this.createToolbarIconButton(actions, 'copy', t.viewCopyArticle, () => {
      void this.copyArticleContent();
    });
    this.createToolbarIconButton(actions, 'pencil', t.viewArticleEdit, () => {
      void this.openArticleEditor();
    });
    if (this.activeTab === 'current') {
      this.createToolbarIconButton(actions, 'bot', t.viewArticleOptimize, () => {
        this.switchFooterChatTab('optimize');
      });
    }

    const versionLayer = host.createDiv({ cls: 'vault-finder-article-version-layer' });

    const prevRail = versionLayer.createDiv({ cls: 'vault-finder-version-rail vault-finder-version-rail-prev' });
    const prevBtn = this.createToolbarIconButton(
      prevRail,
      'chevron-left',
      t.viewArticleVersionPrev,
      () => this.navigateArticleVersion(-1),
      'vault-finder-version-nav vault-finder-version-prev',
    );

    const contentCol = versionLayer.createDiv({ cls: 'vault-finder-article-version-content' });
    const versionLabel = contentCol.createSpan({ cls: 'vault-finder-article-version-label' });
    const inner = contentCol.createDiv({ cls: 'vault-finder-article-inner' });
    const main = inner.createDiv({ cls: 'vault-finder-article-main' });
    const body = main.createEl('div', {
      cls: 'vault-finder-article-body markdown-rendered',
    });

    const nextRail = versionLayer.createDiv({ cls: 'vault-finder-version-rail vault-finder-version-rail-next' });
    const nextBtn = this.createToolbarIconButton(
      nextRail,
      'chevron-right',
      t.viewArticleVersionNext,
      () => this.navigateArticleVersion(1),
      'vault-finder-version-nav vault-finder-version-next',
    );

    const displayMarkdown = this.getDisplayMarkdown(markdown);
    await MarkdownRenderer.render(this.app, displayMarkdown, body, '', this);
    if (this.showArticleSources) {
      attachInternalLinkHandler(body, this.app, (el, type, handler) => {
        this.registerDomEvent(el, type, handler);
      });
    }

    this.articleVersionNavState = {
      versionLayer,
      prevBtn,
      nextBtn,
      versionLabel,
    };

    this.updateArticleVersionNavDisplay();
  }

  private updateArticleVersionNavDisplay(): void {
    const state = this.articleVersionNavState;
    if (!state) return;

    const { versionLayer, prevBtn, nextBtn, versionLabel } = state;
    const multi = this.articleVersions.length > 1;
    versionLayer.toggleClass('has-multiple-versions', multi);
    this.updateVersionLabel(versionLabel);
    prevBtn.toggleClass('is-disabled', !multi || this.articleVersionIndex <= 0);
    nextBtn.toggleClass(
      'is-disabled',
      !multi || this.articleVersionIndex >= this.articleVersions.length - 1,
    );
  }

  private createToolbarIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    extraClass = 'vault-finder-icon-btn',
  ): HTMLButtonElement {
    const btn = parent.createEl('button', {
      cls: extraClass,
      type: 'button',
      attr: { 'aria-label': label, title: label },
    });
    setIcon(btn.createSpan({ cls: 'vault-finder-icon-btn-inner' }), icon);
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      onClick();
    });
    return btn;
  }

  private updateVersionLabel(labelEl: HTMLElement): void {
    const total = this.articleVersions.length;
    if (total <= 1) {
      labelEl.setText('');
      return;
    }
    labelEl.setText(this.plugin.t().viewArticleVersionLabel(this.articleVersionIndex + 1, total));
  }

  private toggleArticleSourceVisibility(): void {
    this.showArticleSources = !this.showArticleSources;
    void this.refreshArticleBody();
  }

  private async refreshArticleBody(): Promise<void> {
    const host = this.activeArticleHost ?? this.getActiveArticleHost();
    if (!host) return;
    const markdown = this.getCurrentArticleMarkdown();
    if (!markdown) return;
    await this.renderArticleChrome(host, markdown);
  }

  private getActiveEditorPanel(): ArticleEditorPanel | null {
    if (this.activeTab === 'history' && this.historyView === 'detail') {
      return this.historyArticleEditor;
    }
    return this.articleEditorPanel;
  }

  private ensureHistoryEditor(): ArticleEditorPanel {
    if (!this.historyArticleEditor) {
      this.historyArticleEditor = new ArticleEditorPanel(this.app, this, {
        getStrings: () => this.plugin.t(),
        onSave: (markdown) => void this.closeArticleEditor(true, markdown),
        onCancel: () => void this.closeArticleEditor(false),
      });
      const articleHost = this.historyDetailEl.querySelector('.vault-finder-history-article');
      if (articleHost instanceof HTMLElement) {
        this.historyArticleEditor.mount(this.historyDetailEl, articleHost);
      } else {
        this.historyArticleEditor.mount(this.historyDetailEl);
      }
    }
    return this.historyArticleEditor;
  }

  private setArticleEditLayout(editing: boolean): void {
    this.articleEditing = editing;
    if (this.activeTab === 'current') {
      this.currentPanelEl.toggleClass('is-article-editing', editing);
      return;
    }
    if (this.activeTab === 'history' && this.historyView === 'detail') {
      this.historyDetailEl.toggleClass('is-article-editing', editing);
    }
  }

  private async openArticleEditor(): Promise<void> {
    const markdown = this.getCurrentArticleMarkdown();
    if (!markdown) return;

    const panel =
      this.activeTab === 'history' && this.historyView === 'detail'
        ? this.ensureHistoryEditor()
        : this.articleEditorPanel;
    if (!panel || panel.isOpen()) return;

    this.setArticleEditLayout(true);
    panel.open(markdown);
  }

  private async closeArticleEditor(save: boolean, savedMarkdown?: string): Promise<void> {
    const panel = this.getActiveEditorPanel();
    if (!panel?.isOpen()) {
      this.setArticleEditLayout(false);
      return;
    }

    if (save && savedMarkdown !== undefined) {
      this.setCurrentArticleMarkdown(savedMarkdown);
    }

    panel.close();
    this.setArticleEditLayout(false);

    if (save && savedMarkdown !== undefined) {
      const host = this.getActiveArticleHost();
      if (host) {
        await this.renderArticleChrome(host, savedMarkdown);
      }
    }
  }

  private async navigateArticleVersion(delta: number): Promise<void> {
    if (this.articleVersions.length <= 1) return;
    const next = this.articleVersionIndex + delta;
    if (next < 0 || next >= this.articleVersions.length) return;
    this.articleVersionIndex = next;
    this.articleEditing = false;
    this.historyArticleEditor?.close();
    this.setArticleEditLayout(false);
    const markdown = this.getCurrentArticleMarkdown();
    const host = this.activeArticleHost ?? this.getActiveArticleHost();
    if (!host || !markdown) return;
    this.syncControllerToCurrentVersion();
    await this.renderArticleChrome(host, markdown);
    this.updateArticleVersionNavDisplay();
  }

  private getActiveArticleHost(): HTMLElement | null {
    if (this.activeTab === 'history' && this.historyView === 'detail') {
      return this.getHistoryArticleEl();
    }
    return this.articleEl;
  }

  private async copyArticleContent(): Promise<void> {
    const t = this.plugin.t();
    const markdown = this.getCurrentArticleMarkdown();
    if (!markdown) return;
    const text = copyTextForArticle(markdown, this.showArticleSources);
    try {
      await navigator.clipboard.writeText(text);
      new Notice(t.noticeArticleCopied);
    } catch {
      new Notice(t.noticeArticleCopyFailed);
    }
  }

  private async runArticleOptimize(
    instruction: string,
    provider: AiProvider,
    model: string,
  ): Promise<void> {
    const t = this.plugin.t();
    const article = this.getCurrentArticleMarkdown();
    if (!article) return;

    if (!isAiActive(this.plugin.settings)) {
      const reason = !this.plugin.settings.aiEnabled
        ? t.noticeArticleOptimizeNotEnabled
        : !hasValidAiKey(this.plugin.settings)
          ? t.noticeArticleOptimizeNoApiKey
          : t.searchAiFailed;
      new Notice(aiErrorNotice(t.noticeArticleOptimizeFailed, new Error(reason)), 10000);
      return;
    }

    this.optimizeForm?.setRunning(true);
    try {
      const query = this.saveQueryForArticleSave();
      const sourceArticle = this.getCurrentArticleMarkdown();
      if (!sourceArticle) return;

      const refined = await this.plugin.aiService.refineArticle(instruction, sourceArticle, query, {
        provider,
        model,
      });
      if (!refined.trim()) {
        throw new Error(`${provider} / ${model}: empty response`);
      }
      this.setCurrentArticleMarkdown(refined, { appendVersion: true });
      this.articleEditing = false;
      const host = this.activeArticleHost ?? this.getActiveArticleHost();
      const displayed = this.getCurrentArticleMarkdown();
      if (host && displayed) {
        await this.renderArticleChrome(host, displayed);
      } else if (displayed) {
        await this.renderArticle(displayed, false);
      }
      this.updateArticleVersionNavDisplay();
      new Notice(t.noticeArticleOptimized);
    } catch (error) {
      new Notice(aiErrorNotice(t.noticeArticleOptimizeFailed, error), 10000);
    } finally {
      this.optimizeForm?.setRunning(false);
    }
  }

  private getHistoryArticleEl(): HTMLElement | null {
    return this.historyDetailEl.querySelector('.vault-finder-history-article');
  }

  private renderResults(): void {
    const resultsTarget =
      this.activeTab === 'history' && this.historyView === 'detail'
        ? this.historyDetailEl.querySelector('.vault-finder-history-results')
        : this.resultsEl;
    if (!(resultsTarget instanceof HTMLElement)) return;

    resultsTarget.empty();
    const query =
      this.activeTab === 'history' && this.viewingHistoryEntry
        ? this.viewingHistoryEntry.query
        : this.inputEl.value.trim();
    if (!query) return;

    const t = this.plugin.t();
    const status = this.plugin.index.getStatus();
    if (status.isRebuilding && status.documentCount === 0) {
      resultsTarget.createEl('div', {
        cls: 'vault-finder-empty',
        text: status.isVectorBuilding ? t.searchVectorIndexing : t.searchIndexing,
      });
      return;
    }

    if (this.controller.primaryHits.length === 0 && this.controller.weakHits.length === 0) {
      resultsTarget.createEl('div', { cls: 'vault-finder-empty', text: t.searchNoResults });
      return;
    }

    const articleEl =
      this.activeTab === 'history'
        ? this.getHistoryArticleEl()
        : this.articleEl.querySelector('.vault-finder-article-body');
    const hasArticle = articleEl !== null;

    if (this.controller.primaryHits.length === 0 && this.controller.weakHits.length > 0) {
      resultsTarget.createEl('div', {
        cls: 'vault-finder-weak-notice',
        text: t.searchNoStrongResults,
      });
    }

    if (this.controller.primaryHits.length > 0) {
      if (this.plugin.isAiActive() && hasArticle) {
        resultsTarget.createEl('div', { cls: 'vault-finder-sources-heading', text: t.viewSourceHits });
      }
      this.renderHitList(resultsTarget, this.controller.primaryHits, 0, false);
    }

    if (this.controller.weakHits.length > 0) {
      resultsTarget.createEl('div', {
        cls: 'vault-finder-sources-heading vault-finder-weak-heading',
        text: t.viewWeakMatchHits,
      });
      const offset = this.controller.primaryHits.length;
      this.renderHitList(resultsTarget, this.controller.weakHits, offset, true);
    }
  }

  private renderHitList(
    parent: HTMLElement,
    hits: SearchHit[],
    indexOffset: number,
    isWeak: boolean,
  ): void {
    hits.forEach((hit, localIndex) => {
      const index = indexOffset + localIndex;
      const row = parent.createEl('div', {
        cls: `vault-finder-result${index === this.controller.selectedIndex ? ' is-selected' : ''}${isWeak ? ' is-weak' : ''}`,
      });

      const titleRow = row.createEl('div', { cls: 'vault-finder-result-title-row' });
      titleRow.createEl('div', { cls: 'vault-finder-result-title', text: hit.title });
      if (hit.matchPercent !== undefined) {
        titleRow.createEl('span', {
          cls: `vault-finder-match-badge${isWeak ? ' is-weak' : ''}${hit.exactMatch ? ' is-exact' : ''}`,
          text: hit.exactMatch ? `${hit.matchPercent}% · ${this.plugin.t().viewExactMatch}` : `${hit.matchPercent}%`,
        });
      }

      row.createEl('div', { cls: 'vault-finder-result-snippet', text: hit.snippet });

      const pathEl = row.createEl('div', { cls: 'vault-finder-result-path', text: hit.path });
      pathEl.addEventListener('click', (evt) => {
        evt.stopPropagation();
        void openVaultLink(this.app, hit.path);
      });

      row.addEventListener('click', () => {
        this.controller.selectedIndex = index;
        this.renderResults();
        void openVaultLink(this.app, hit.path);
      });
    });
  }

  private renderHistoryList(): void {
    this.historyListEl.empty();
    this.historyDetailEl.empty();
    this.historyArticleEditor?.destroy();
    this.historyArticleEditor = null;
    this.historyDetailEl.addClass('is-hidden');
    this.historyListEl.removeClass('is-hidden');

    const t = this.plugin.t();
    const entries = this.plugin.searchHistory.entries;
    if (entries.length === 0) {
      this.historyListEl.createEl('div', { cls: 'vault-finder-empty', text: t.viewHistoryEmpty });
      return;
    }

    for (const entry of entries) {
      const row = this.historyListEl.createEl('div', { cls: 'vault-finder-history-item' });
      row.createEl('div', { cls: 'vault-finder-history-query', text: entry.query });
      row.createEl('div', {
        cls: 'vault-finder-history-meta',
        text: t.viewHistoryMeta(entry.hits.length, new Date(entry.timestamp)),
      });
      row.addEventListener('click', () => this.openHistoryEntry(entry));
    }
  }

  private openHistoryEntry(entry: SearchHistoryEntry): void {
    this.historyView = 'detail';
    this.viewingHistoryEntry = entry;
    this.historyListEl.addClass('is-hidden');
    this.historyDetailEl.removeClass('is-hidden');
    this.historyDetailEl.empty();

    const t = this.plugin.t();
    const header = this.historyDetailEl.createEl('div', { cls: 'vault-finder-history-detail-header' });
    const backBtn = header.createEl('button', {
      cls: 'vault-finder-history-back',
      text: t.viewHistoryBack,
      type: 'button',
    });
    backBtn.addEventListener('click', () => this.renderHistoryList());

    header.createEl('div', { cls: 'vault-finder-history-detail-query', text: entry.query });
    header.createEl('div', {
      cls: 'vault-finder-history-detail-meta',
      text: t.viewHistoryMeta(entry.hits.length, new Date(entry.timestamp)),
    });

    const articleHost = this.historyDetailEl.createEl('div', { cls: 'vault-finder-history-article vault-finder-article' });
    this.historyDetailEl.createEl('div', { cls: 'vault-finder-history-results vault-finder-results' });

    this.controller.applyMatchSplit(entry.hits.map((hit) => ({ ...hit })));
    this.controller.selectedIndex = -1;
    this.controller.article = entry.article;
    this.articleVersions = entry.article?.trim() ? [entry.article] : [];
    this.articleVersionIndex = 0;
    this.showArticleSources = true;
    this.articleEditing = false;
    this.historyArticleEditor?.close();
    this.setArticleEditLayout(false);

    if (entry.article?.trim()) {
      void this.renderArticleInto(articleHost, entry.article);
    } else {
      articleHost.remove();
      this.renderResults();
    }
  }

  private async renderArticleInto(host: HTMLElement, markdown: string): Promise<void> {
    host.setAttr('title', this.plugin.t().viewArticleSaveHint);
    this.activeArticleHost = host;
    await this.renderArticleChrome(host, markdown);
    this.renderResults();
  }

  private setupArticleSaveContextMenus(): void {
    this.registerDomEvent(this.articleEl, 'contextmenu', (evt) => {
      if (this.activeTab !== 'current') return;
      if (!this.isArticleContextEvent(evt)) return;
      this.showArticleSaveMenu(evt, () => this.getCurrentArticleMarkdown());
    });

    this.registerDomEvent(this.historyDetailEl, 'contextmenu', (evt) => {
      if (this.activeTab !== 'history' || this.historyView !== 'detail') return;
      if (!this.isArticleContextEvent(evt)) return;
      this.showArticleSaveMenu(evt, () => this.getCurrentArticleMarkdown());
    });
  }

  private isArticleContextEvent(evt: MouseEvent): boolean {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return false;
    return target.closest('.vault-finder-article-body') !== null;
  }

  private showArticleSaveMenu(evt: MouseEvent, getArticle: () => string | null | undefined): void {
    const markdown = getArticle()?.trim() ?? '';
    if (!markdown) return;
    evt.preventDefault();
    const t = this.plugin.t();
    const menu = new Menu();

    menu.addItem((item) => {
      item.setIcon('copy').setTitle(t.viewCopyArticle).onClick(() => {
        void this.copyArticleToClipboard(getArticle, t);
      });
    });

    const exportItems: { format: ArticleExportFormat; icon: string; label: string }[] = [
      { format: 'md', icon: 'file-text', label: t.viewExportMarkdown },
      { format: 'html', icon: 'globe', label: t.viewExportHtml },
      { format: 'pdf', icon: 'file-output', label: t.viewExportPdf },
      { format: 'png', icon: 'image', label: t.viewExportImage },
    ];
    for (const { format, icon, label } of exportItems) {
      menu.addItem((item) => {
        item.setIcon(icon).setTitle(label).onClick(() => {
          void this.exportArticle(format, getArticle, label, t);
        });
      });
    }

    menu.addSeparator();

    const recent = this.plugin.settings.articleSaveFolderHistory;

    for (const folderPath of recent) {
      menu.addItem((item) => {
        item
          .setIcon('folder')
          .setTitle(this.formatSaveFolderMenuLabel(folderPath, t))
          .onClick(() => {
            void this.saveArticleToFolder(folderPath, getArticle, t);
          });
      });
    }

    if (recent.length > 0) {
      menu.addSeparator();
    }

    menu.addItem((item) => {
      item.setIcon('folder-plus').setTitle(t.viewSaveArticlePickFolder).onClick(() => {
        new FolderPickerModal(this.app, makeFolderPickerLabels(t), (folderPath) => {
          void this.saveArticleToFolder(folderPath, getArticle, t);
        }).open();
      });
    });
    menu.showAtMouseEvent(evt);
  }

  private formatSaveFolderMenuLabel(folderPath: string, t: I18nStrings): string {
    return folderPath ? folderPath : t.folderPickerRoot;
  }

  private getArticleBodyEl(): HTMLElement | null {
    if (this.activeTab === 'history' && this.historyView === 'detail') {
      return this.historyDetailEl.querySelector('.vault-finder-article-body');
    }
    return this.articleEl.querySelector('.vault-finder-article-body');
  }

  private async exportArticle(
    format: ArticleExportFormat,
    getArticle: () => string | null | undefined,
    dialogTitle: string,
    t: I18nStrings,
  ): Promise<void> {
    const markdown = getArticle()?.trim() ?? '';
    if (!markdown) return;
    const basename = buildArticleFilename(this.saveQueryForArticleSave() || 'search');
    const bodyHtml = this.getArticleBodyEl()?.innerHTML ?? '';
    await exportArticleToDisk({
      app: this.app,
      format,
      markdown,
      bodyHtml,
      basename,
      dialogTitle,
      notices: {
        exported: t.noticeArticleExported,
        failed: t.noticeArticleExportFailed,
      },
      pickVaultFolder: () =>
        new Promise((resolve) => {
          new FolderPickerModal(this.app, makeFolderPickerLabels(t), (folderPath) => {
            resolve(folderPath);
          }).open();
        }),
      onVaultFolderUsed: (folder) => {
        this.plugin.settings.articleSaveFolderHistory = rememberArticleSaveFolder(
          this.plugin.settings.articleSaveFolderHistory,
          folder,
        );
        void this.plugin.saveSettings();
      },
      renderMarkdownHtml: async (md) => {
        const div = window.activeDocument.createElement('div');
        div.className = 'vault-finder-article-body markdown-rendered';
        await MarkdownRenderer.render(this.app, md, div, '', this);
        return Array.from(div.childNodes)
          .map((node) => new XMLSerializer().serializeToString(node))
          .join('');
      },
    });
  }

  private async copyArticleToClipboard(
    getArticle: () => string | null | undefined,
    t: I18nStrings,
  ): Promise<void> {
    const markdown = getArticle()?.trim() ?? '';
    if (!markdown) return;
    const text = copyTextForArticle(markdown, this.showArticleSources);
    try {
      await navigator.clipboard.writeText(text);
      new Notice(t.noticeArticleCopied);
    } catch {
      new Notice(t.noticeArticleCopyFailed);
    }
  }

  private saveQueryForArticleSave(): string {
    if (this.activeTab === 'history' && this.viewingHistoryEntry) {
      return this.viewingHistoryEntry.query;
    }
    return this.inputEl.value.trim();
  }

  private async saveArticleToFolder(
    folderPath: string,
    getArticle: () => string | null | undefined,
    t: I18nStrings,
  ): Promise<void> {
    const latestMarkdown = getArticle()?.trim() ?? '';
    if (!latestMarkdown) return;

    const savedPath = await saveMarkdownToFolder(
      this.app,
      folderPath,
      buildArticleFilename(this.saveQueryForArticleSave() || 'search'),
      latestMarkdown,
      {
        saved: t.noticeArticleSaved,
        failed: t.noticeArticleSaveFailed,
      },
    );

    if (savedPath === null) return;

    this.plugin.settings.articleSaveFolderHistory = rememberArticleSaveFolder(
      this.plugin.settings.articleSaveFolderHistory,
      folderPath,
    );
    await this.plugin.saveSettings();
  }

  private updateStatus(): void {
    const t = this.plugin.t();

    if (this.controller.isSearching) {
      const phaseText = this.phaseStatusText(t);
      this.statusEl.setText(phaseText);
      this.statusEl.toggleClass('is-busy', true);
      return;
    }

    this.statusEl.toggleClass('is-busy', false);
    const status = this.plugin.index.getStatus();
    if (status.isRebuilding || status.isVectorBuilding) {
      this.statusEl.setText(
        status.isVectorBuilding ? t.searchVectorIndexing : t.searchIndexing,
      );
      return;
    }

    const query = this.inputEl.value.trim();
    const total = this.controller.primaryHits.length + this.controller.weakHits.length;
    if (query && total > 0) {
      const scopeLabel =
        this.scopePicker.getValue().trim().length > 0
          ? t.viewScopeLabel(this.scopePicker.getValue())
          : t.viewScopeEntireVault;
      const parts = [t.searchResultsCount(this.controller.primaryHits.length)];
      if (this.controller.weakHits.length > 0) {
        parts.push(t.searchWeakResultsCount(this.controller.weakHits.length));
      }
      parts.push(scopeLabel);
      parts.push(t.viewMatchThresholdShort(this.plugin.settings.searchMatchThreshold));
      this.statusEl.setText(parts.join(' · '));
    } else if (query && total === 0 && !this.controller.isSearching) {
      this.statusEl.setText(t.searchNoResults);
    } else {
      this.statusEl.setText('');
    }
  }

  private phaseStatusText(t: ReturnType<VaultFinderPlugin['t']>): string {
    switch (this.controller.searchPhase) {
      case 'local':
        return t.searchPhaseLocal;
      case 'ai-expand':
        return t.searchPhaseAiExpand;
      case 'ai-filter':
        return t.searchPhaseAiFilter;
      case 'ai-article':
        return t.searchPhaseAiArticle;
      default:
        return t.searchPhaseLocal;
    }
  }

  private scrollToSelected(): void {
    const selected = this.resultsEl.querySelector('.is-selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }
}
