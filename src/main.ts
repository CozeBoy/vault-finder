import { Notice, Plugin, TFile } from 'obsidian';
import { AiService } from './ai/service';
import { EmbeddingService } from './ai/embeddings';
import { getStrings, type I18nStrings } from './i18n';
import { VaultIndex } from './index/indexer';
import { ensureKeywordCacheDir, KeywordCacheStorage } from './index/keywordCacheStorage';
import {
  ensureVectorCacheDir,
  openPathInFileManager,
  stripLegacyPluginCachesFromRecord,
  VectorCacheStorage,
} from './index/vectorCacheStorage';
import {
  DEFAULT_SETTINGS,
  isAiActive,
  isPartialSettings,
  normalizeExtensions,
  normalizeExcludePaths,
  normalizeExcludeExtensions,
  normalizeArticleSaveFolderHistory,
  normalizeArticleOptimizeShortcuts,
  syncPromptsToLanguage,
  type VaultFinderSettings,
} from './settings';
import { normalizeCustomModels } from './ai/models';
import { VaultFinderSettingTab } from './settingTab';
import { attachRibbonContextMenu } from './ui/ribbon';
import { markReopenSettingsIfActive, consumeReopenSettingsFlag, openPluginSettings } from './ui/pluginSettings';
import { SearchHistoryStore } from './ui/searchHistory';
import { SearchView, VAULT_FINDER_VIEW_TYPE } from './ui/searchView';

export default class VaultFinderPlugin extends Plugin {
  settings: VaultFinderSettings = { ...DEFAULT_SETTINGS };
  index!: VaultIndex;
  aiService!: AiService;
  embeddingService!: EmbeddingService;
  searchHistory!: SearchHistoryStore;
  ribbonIconEl: HTMLElement | null = null;
  settingTab!: VaultFinderSettingTab;
  private savedVectorCacheFolder = DEFAULT_SETTINGS.vectorCacheFolder;
  private savedKeywordCacheFolder = DEFAULT_SETTINGS.keywordCacheFolder;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.searchHistory = new SearchHistoryStore(
      () => this.loadData(),
      (data) => this.saveData(data),
    );
    await this.searchHistory.load();

    this.embeddingService = new EmbeddingService(() => this.settings);

    this.index = new VaultIndex(
      this.app,
      this.settings,
      {
        loadData: () => this.loadData(),
        saveData: (data) => this.saveData(data),
      },
      this.embeddingService,
      new KeywordCacheStorage(this.app, this.manifest.id, () => this.settings.keywordCacheFolder),
      new VectorCacheStorage(this.app, this.manifest.id, () => this.settings.vectorCacheFolder),
    );

    this.aiService = new AiService(() => this.settings);

    this.registerView(VAULT_FINDER_VIEW_TYPE, (leaf) => new SearchView(leaf, this));

    this.settingTab = new VaultFinderSettingTab(this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: 'open-search',
      name: this.t().commandOpenSearch,
      callback: () => void this.openSearch(),
    });

    this.addCommand({
      id: 'rebuild-index',
      name: this.t().commandRebuildIndex,
      callback: () => void this.rebuildIndex(),
    });

    this.registerVaultEvents();
    this.refreshRibbonIcon();

    this.register(() => {
      this.ribbonIconEl?.remove();
      this.ribbonIconEl = null;
    });

    void this.index.initialize().then((legacyCleaned) => {
      if (legacyCleaned) {
        new Notice(this.t().noticeLegacyCacheCleaned);
      }
    });

    if (consumeReopenSettingsFlag()) {
      window.setTimeout(() => openPluginSettings(this.app, this.manifest.id), 100);
    }

    this.refreshSearchViews();
  }

  onunload(): void {
    markReopenSettingsIfActive(this.app, this.manifest.id);
    this.settingTab?.stopStatusPoll();
    this.ribbonIconEl?.remove();
    this.ribbonIconEl = null;
    this.index.dispose();
  }

  t(): I18nStrings {
    return getStrings(this.settings.language);
  }

  isAiActive(): boolean {
    return isAiActive(this.settings);
  }

  async openSearch(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VAULT_FINDER_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      await rightLeaf.setViewState({ type: VAULT_FINDER_VIEW_TYPE, active: true });
      leaf = rightLeaf;
    } else {
      workspace.setActiveLeaf(leaf, { focus: true });
    }
    const view = leaf.view;
    if (view instanceof SearchView) {
      view.focusSearchInput();
    }
  }

  async rebuildVectorIndex(): Promise<void> {
    const t = this.t();
    new Notice(t.noticeRebuildVectorStarted);
    try {
      await this.index.rebuildVectorIndex();
      new Notice(t.noticeRebuildVectorDone);
      this.settingTab.refreshIndexStatusDisplay();
    } catch {
      new Notice(t.noticeRebuildVectorFailed);
    }
  }

  async openVectorCacheFolder(): Promise<void> {
    const t = this.t();
    const dir = ensureVectorCacheDir(
      this.app,
      this.manifest.id,
      this.settings.vectorCacheFolder,
    );
    if (!dir) {
      new Notice(t.noticeVectorCacheFolderOpenFailed);
      return;
    }
    const ok = await openPathInFileManager(dir);
    new Notice(ok ? t.noticeVectorCacheFolderOpened : t.noticeVectorCacheFolderOpenFailed);
  }

  async openKeywordCacheFolder(): Promise<void> {
    const t = this.t();
    const dir = ensureKeywordCacheDir(
      this.app,
      this.manifest.id,
      this.settings.keywordCacheFolder,
    );
    if (!dir) {
      new Notice(t.noticeKeywordCacheFolderOpenFailed);
      return;
    }
    const ok = await openPathInFileManager(dir);
    new Notice(ok ? t.noticeKeywordCacheFolderOpened : t.noticeKeywordCacheFolderOpenFailed);
  }

  async rebuildIndex(): Promise<void> {
    const t = this.t();
    new Notice(t.noticeRebuildStarted);
    try {
      await this.index.rebuildAll();
      new Notice(t.noticeRebuildDone);
      this.settingTab.refreshIndexStatusDisplay();
    } catch {
      new Notice(t.noticeRebuildFailed);
    }
  }

  refreshRibbonIcon(): void {
    if (this.ribbonIconEl) {
      this.ribbonIconEl.remove();
      this.ribbonIconEl = null;
    }

    // Clean up stray icons from hot-reload during development
    window.activeDocument
      .querySelectorAll('.side-dock-ribbon .vault-finder-ribbon')
      .forEach((el) => el.remove());

    if (!this.settings.showRibbonIcon) return;

    this.ribbonIconEl = this.addRibbonIcon('search', this.t().ribbonTooltip, () => {
      void this.openSearch();
    });
    this.ribbonIconEl.addClass('vault-finder-ribbon');
    attachRibbonContextMenu(this, this.ribbonIconEl);
  }

  refreshSearchViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VAULT_FINDER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SearchView) {
        view.applyLocale();
      }
    }
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    if (typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      const stored = record.settings;
      if (isPartialSettings(stored)) {
        this.settings = this.mergeSettings(stored);
        if (syncPromptsToLanguage(this.settings)) {
          await this.saveSettings();
        }
        this.savedVectorCacheFolder = this.settings.vectorCacheFolder;
        this.savedKeywordCacheFolder = this.settings.keywordCacheFolder;
        return;
      }
      const rest = { ...record };
      delete rest.indexCache;
      if (isPartialSettings(rest)) {
        this.settings = this.mergeSettings(rest);
      }
    }
    this.savedVectorCacheFolder = this.settings.vectorCacheFolder;
    this.savedKeywordCacheFolder = this.settings.keywordCacheFolder;
  }

  async saveSettings(): Promise<void> {
    const prevVectorCacheFolder = this.savedVectorCacheFolder;
    const prevKeywordCacheFolder = this.savedKeywordCacheFolder;
    const data: unknown = await this.loadData();
    const base =
      typeof data === 'object' && data !== null
        ? stripLegacyPluginCachesFromRecord(data as Record<string, unknown>)
        : {};
    await this.saveData({ ...base, settings: this.settings });

    if (prevVectorCacheFolder !== this.settings.vectorCacheFolder) {
      this.index.migrateVectorCacheFolder(prevVectorCacheFolder);
      this.savedVectorCacheFolder = this.settings.vectorCacheFolder;
      new Notice(this.t().noticeVectorCacheMigrated);
    }

    if (prevKeywordCacheFolder !== this.settings.keywordCacheFolder) {
      this.index.migrateKeywordCacheFolder(prevKeywordCacheFolder);
      this.savedKeywordCacheFolder = this.settings.keywordCacheFolder;
      new Notice(this.t().noticeKeywordCacheMigrated);
    }

    this.index.updateSettings(this.settings);
  }

  private mergeSettings(partial: Partial<VaultFinderSettings>): VaultFinderSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...partial,
      indexableExtensions: normalizeExtensions(
        partial.indexableExtensions ?? DEFAULT_SETTINGS.indexableExtensions,
      ),
      excludePaths: normalizeExcludePaths(partial.excludePaths ?? DEFAULT_SETTINGS.excludePaths),
      excludeExtensions: normalizeExcludeExtensions(
        partial.excludeExtensions ?? DEFAULT_SETTINGS.excludeExtensions,
      ),
      aiCustomModels: normalizeCustomModels(partial.aiCustomModels ?? DEFAULT_SETTINGS.aiCustomModels),
      vectorCustomEmbeddingModels:
        partial.vectorCustomEmbeddingModels ?? DEFAULT_SETTINGS.vectorCustomEmbeddingModels,
      vectorCacheFolder: partial.vectorCacheFolder ?? DEFAULT_SETTINGS.vectorCacheFolder,
      keywordCacheFolder: partial.keywordCacheFolder ?? DEFAULT_SETTINGS.keywordCacheFolder,
      aiRelevancePrompt: partial.aiRelevancePrompt ?? DEFAULT_SETTINGS.aiRelevancePrompt,
      aiFilterIrrelevantResults:
        partial.aiFilterIrrelevantResults ?? DEFAULT_SETTINGS.aiFilterIrrelevantResults,
      searchMatchThreshold: partial.searchMatchThreshold ?? DEFAULT_SETTINGS.searchMatchThreshold,
      showWeakMatchResults: partial.showWeakMatchResults ?? DEFAULT_SETTINGS.showWeakMatchResults,
      vectorEmbedConcurrency:
        partial.vectorEmbedConcurrency ?? DEFAULT_SETTINGS.vectorEmbedConcurrency,
      articleSaveFolderHistory: normalizeArticleSaveFolderHistory(
        partial.articleSaveFolderHistory ?? DEFAULT_SETTINGS.articleSaveFolderHistory,
      ),
      articleOptimizeShortcuts: normalizeArticleOptimizeShortcuts(
        partial.articleOptimizeShortcuts ?? DEFAULT_SETTINGS.articleOptimizeShortcuts,
      ),
    };
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile) this.index.scheduleFileUpdate(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.index.scheduleFileUpdate(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.index.removeFile(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.index.handleRename(file, oldPath);
      }),
    );
  }
}
