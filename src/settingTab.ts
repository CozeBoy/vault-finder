import { PluginSettingTab, Setting } from 'obsidian';
import type VaultFinderPlugin from './main';
import {
  AI_PROVIDERS,
  DEFAULT_SETTINGS,
  defaultKeywordPrompt,
  defaultRelevancePrompt,
  defaultResultPrompt,
  syncPromptsToLanguage,
  type AiProvider,
  allEmbeddingModels,
  clampVectorEmbedConcurrency,
  defaultModelForProvider,
  normalizeExtensions,
  normalizeExcludePaths,
  parseExcludeExtensionsInput,
  parseCustomEmbeddingModels,
  VECTOR_EMBED_CONCURRENCY_MAX,
  VECTOR_EMBED_CONCURRENCY_MIN,
} from './settings';
import { clampMatchThreshold } from './index/matchScore';
import { formatKeywordCacheFolderDisplay } from './index/keywordCacheStorage';
import { formatVectorCacheFolderDisplay } from './index/vectorCacheStorage';
import { FolderPickerModal, makeFolderPickerLabels } from './ui/folderPickerModal';
import {
  allModelsForProvider,
  customModelsToText,
  parseCustomModels,
} from './ai/models';

export class VaultFinderSettingTab extends PluginSettingTab {
  private indexStatusSetting: Setting | null = null;
  private statusPollTimer: number | null = null;

  constructor(private plugin: VaultFinderPlugin) {
    super(plugin.app, plugin);
  }

  hide(): void {
    this.stopStatusPoll();
  }

  refreshIndexStatusDisplay(): void {
    this.indexStatusSetting?.setDesc(this.formatIndexStatus());
  }

  stopStatusPoll(): void {
    if (this.statusPollTimer !== null) {
      window.clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private startStatusPoll(): void {
    this.stopStatusPoll();
    this.statusPollTimer = window.setInterval(() => {
      this.refreshIndexStatusDisplay();
    }, 2000);
  }

  display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    this.stopStatusPoll();
    if (syncPromptsToLanguage(this.plugin.settings)) {
      void this.plugin.saveSettings();
    }
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.t();
    const s = this.plugin.settings;

    new Setting(containerEl).setName(t.settingsGeneral).setHeading();

    new Setting(containerEl)
      .setName(t.settingsLanguage)
      .setDesc(t.settingsLanguageDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption('auto', t.settingsLanguageAuto)
          .addOption('zh-CN', t.settingsLanguageZh)
          .addOption('en', t.settingsLanguageEn)
          .setValue(s.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as typeof s.language;
            syncPromptsToLanguage(this.plugin.settings);
            await this.plugin.saveSettings();
            this.plugin.refreshRibbonIcon();
            this.plugin.refreshSearchViews();
            this.renderSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t.settingsRibbon)
      .setDesc(t.settingsRibbonDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.showRibbonIcon).onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
          this.plugin.refreshRibbonIcon();
        }),
      );

    new Setting(containerEl).setName(t.settingsIndexing).setHeading();

    this.indexStatusSetting = new Setting(containerEl)
      .setName(t.settingsIndexStatus)
      .setDesc(this.formatIndexStatus())
      .addButton((btn) =>
        btn.setButtonText(t.settingsRefreshIndexStatus).onClick(() => {
          this.refreshIndexStatusDisplay();
        }),
      );

    this.startStatusPoll();

    new Setting(containerEl)
      .setName(t.settingsExtensions)
      .setDesc(t.settingsExtensionsDesc)
      .addText((text) =>
        text
          .setValue(s.indexableExtensions.join(', '))
          .onChange(async (value) => {
            const prev = { ...this.plugin.settings };
            this.plugin.settings.indexableExtensions = normalizeExtensions(
              value.split(/[,，\s]+/),
            );
            await this.plugin.saveSettings();
            if (this.plugin.index.settingsFingerprintChanged(prev)) {
              void this.plugin.rebuildIndex();
            }
          }),
      );

    let excludePathsArea: HTMLTextAreaElement | null = null;
    new Setting(containerEl)
      .setName(t.settingsExcludePaths)
      .setDesc(t.settingsExcludePathsDesc)
      .addTextArea((area) => {
        excludePathsArea = area.inputEl;
        area
          .setValue(s.excludePaths.join('\n'))
          .onChange(async (value) => {
            const prev = { ...this.plugin.settings };
            this.plugin.settings.excludePaths = normalizeExcludePaths(value.split('\n'));
            await this.plugin.saveSettings();
            if (this.plugin.index.settingsFingerprintChanged(prev)) {
              void this.plugin.rebuildIndex();
            }
          });
        area.inputEl.rows = 4;
      })
      .addButton((btn) =>
        btn.setButtonText(t.settingsExcludePathsChoose).onClick(() => {
          new FolderPickerModal(this.app, makeFolderPickerLabels(t), (path) => {
            const prev = { ...this.plugin.settings };
            const paths = normalizeExcludePaths([
              ...this.plugin.settings.excludePaths,
              path,
            ]);
            this.plugin.settings.excludePaths = paths;
            if (excludePathsArea) {
              excludePathsArea.value = paths.join('\n');
            }
            void this.plugin.saveSettings().then(() => {
              if (this.plugin.index.settingsFingerprintChanged(prev)) {
                void this.plugin.rebuildIndex();
              }
            });
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsExcludeExtensions)
      .setDesc(t.settingsExcludeExtensionsDesc)
      .addTextArea((area) => {
        area
          .setValue(s.excludeExtensions.join('\n'))
          .onChange(async (value) => {
            const prev = { ...this.plugin.settings };
            this.plugin.settings.excludeExtensions = parseExcludeExtensionsInput(value);
            await this.plugin.saveSettings();
            if (this.plugin.index.settingsFingerprintChanged(prev)) {
              void this.plugin.rebuildIndex();
            }
          });
        area.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName(t.settingsMaxFileSize)
      .setDesc(t.settingsMaxFileSizeDesc)
      .addText((text) =>
        text
          .setValue(String(Math.round(s.maxFileSizeBytes / (1024 * 1024))))
          .onChange(async (value) => {
            const mb = Number.parseInt(value, 10);
            if (Number.isNaN(mb) || mb < 1) return;
            const prev = { ...this.plugin.settings };
            this.plugin.settings.maxFileSizeBytes = mb * 1024 * 1024;
            await this.plugin.saveSettings();
            if (this.plugin.index.settingsFingerprintChanged(prev)) {
              void this.plugin.rebuildIndex();
            }
          }),
      );

    const keywordCacheFolderDisplay = formatKeywordCacheFolderDisplay(
      this.app,
      this.plugin.manifest.id,
      s.keywordCacheFolder,
    );
    new Setting(containerEl)
      .setName(t.settingsKeywordCacheFolder)
      .setDesc(
        `${t.settingsKeywordCacheFolderDesc}\n${t.settingsKeywordCacheFolderResolved(keywordCacheFolderDisplay)}`,
      )
      .addText((text) => {
        text
          .setPlaceholder(t.settingsKeywordCacheFolderPlaceholder)
          .setValue(s.keywordCacheFolder);
        text.inputEl.addEventListener('blur', () => {
          const value = text.getValue().trim();
          if (value === this.plugin.settings.keywordCacheFolder) return;
          this.plugin.settings.keywordCacheFolder = value;
          void this.plugin.saveSettings().then(() => this.renderSettings());
        });
      })
      .addButton((btn) =>
        btn.setButtonText(t.settingsKeywordCacheFolderChoose).onClick(() => {
          new FolderPickerModal(this.app, makeFolderPickerLabels(t), (path) => {
            this.plugin.settings.keywordCacheFolder = path;
            void this.plugin.saveSettings().then(() => this.renderSettings());
          }).open();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t.settingsKeywordCacheFolderReset).onClick(async () => {
          this.plugin.settings.keywordCacheFolder = DEFAULT_SETTINGS.keywordCacheFolder;
          await this.plugin.saveSettings();
          this.renderSettings();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t.settingsKeywordCacheFolderOpen).onClick(() => {
          void this.plugin.openKeywordCacheFolder();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsRebuildIndex)
      .setDesc(t.settingsRebuildIndexDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settingsRebuildIndex).onClick(() => {
          void this.plugin.rebuildIndex();
        }),
      );

    new Setting(containerEl).setName(t.settingsVector).setHeading();

    new Setting(containerEl)
      .setName(t.settingsVectorSearch)
      .setDesc(t.settingsVectorSearchDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.vectorSearchEnabled).onChange(async (value) => {
          this.plugin.settings.vectorSearchEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    const cacheFolderDisplay = formatVectorCacheFolderDisplay(
      this.app,
      this.plugin.manifest.id,
      s.vectorCacheFolder,
    );
    new Setting(containerEl)
      .setName(t.settingsVectorCacheFolder)
      .setDesc(`${t.settingsVectorCacheFolderDesc}\n${t.settingsVectorCacheFolderResolved(cacheFolderDisplay)}`)
      .addText((text) => {
        text
          .setPlaceholder(t.settingsVectorCacheFolderPlaceholder)
          .setValue(s.vectorCacheFolder);
        text.inputEl.addEventListener('blur', () => {
          const value = text.getValue().trim();
          if (value === this.plugin.settings.vectorCacheFolder) return;
          this.plugin.settings.vectorCacheFolder = value;
          void this.plugin.saveSettings().then(() => this.renderSettings());
        });
      })
      .addButton((btn) =>
        btn.setButtonText(t.settingsVectorCacheFolderChoose).onClick(() => {
          new FolderPickerModal(this.app, makeFolderPickerLabels(t), (path) => {
            this.plugin.settings.vectorCacheFolder = path;
            void this.plugin.saveSettings().then(() => this.renderSettings());
          }).open();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t.settingsVectorCacheFolderReset).onClick(async () => {
          this.plugin.settings.vectorCacheFolder = DEFAULT_SETTINGS.vectorCacheFolder;
          await this.plugin.saveSettings();
          this.renderSettings();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(t.settingsVectorCacheFolderOpen).onClick(() => {
          void this.plugin.openVectorCacheFolder();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsVectorBaseUrl)
      .setDesc(t.settingsVectorBaseUrlDesc)
      .addText((text) =>
        text.setValue(s.vectorBaseUrl).onChange(async (value) => {
          this.plugin.settings.vectorBaseUrl =
            value.trim() || DEFAULT_SETTINGS.vectorBaseUrl;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsVectorApiKey)
      .setDesc(t.settingsVectorApiKeyDesc)
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(s.vectorApiKey).onChange(async (value) => {
          this.plugin.settings.vectorApiKey = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t.settingsEmbeddingModel)
      .setDesc(t.settingsEmbeddingModelDesc)
      .addDropdown((dropdown) => {
        const models = allEmbeddingModels(s);
        for (const model of models) {
          dropdown.addOption(model, model);
        }
        dropdown.setValue(
          models.includes(s.embeddingModel) ? s.embeddingModel : (models[0] ?? s.embeddingModel),
        );
        dropdown.onChange(async (value) => {
          this.plugin.settings.embeddingModel = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t.settingsVectorCustomModels)
      .setDesc(t.settingsVectorCustomModelsDesc)
      .addTextArea((area) => {
        area
          .setValue(s.vectorCustomEmbeddingModels.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.vectorCustomEmbeddingModels = parseCustomEmbeddingModels(value);
            const models = allEmbeddingModels(this.plugin.settings);
            if (!models.includes(this.plugin.settings.embeddingModel)) {
              this.plugin.settings.embeddingModel = models[0] ?? DEFAULT_SETTINGS.embeddingModel;
            }
            await this.plugin.saveSettings();
            this.renderSettings();
          });
        area.inputEl.rows = 4;
        area.inputEl.addClass('vault-finder-prompt-area');
      });

    new Setting(containerEl)
      .setName(t.settingsVectorEmbedMaxChars)
      .setDesc(t.settingsVectorEmbedMaxCharsDesc)
      .addText((text) =>
        text.setValue(String(s.vectorEmbedMaxChars)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n) || n < 500) return;
          this.plugin.settings.vectorEmbedMaxChars = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsVectorEmbedConcurrency)
      .setDesc(t.settingsVectorEmbedConcurrencyDesc)
      .addText((text) =>
        text.setValue(String(s.vectorEmbedConcurrency)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n) || n < VECTOR_EMBED_CONCURRENCY_MIN || n > VECTOR_EMBED_CONCURRENCY_MAX) {
            return;
          }
          this.plugin.settings.vectorEmbedConcurrency = clampVectorEmbedConcurrency(n);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsVectorMinScore)
      .setDesc(t.settingsVectorMinScoreDesc)
      .addText((text) =>
        text.setValue(String(s.vectorMinScore)).onChange(async (value) => {
          const n = Number.parseFloat(value);
          if (Number.isNaN(n) || n < 0 || n > 1) return;
          this.plugin.settings.vectorMinScore = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsVectorTimeout)
      .setDesc(t.settingsVectorTimeoutDesc)
      .addText((text) =>
        text.setValue(String(Math.round(s.vectorTimeoutMs / 1000))).onChange(async (value) => {
          const sec = Number.parseInt(value, 10);
          if (Number.isNaN(sec) || sec < 5) return;
          this.plugin.settings.vectorTimeoutMs = sec * 1000;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsRebuildVectorIndex)
      .setDesc(t.settingsRebuildVectorIndexDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settingsRebuildVectorIndex).onClick(() => {
          void this.plugin.rebuildVectorIndex();
        }),
      );

    new Setting(containerEl).setName(t.settingsAi).setHeading();

    new Setting(containerEl)
      .setName(t.settingsAiEnabled)
      .setDesc(t.settingsAiEnabledDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.aiEnabled).onChange(async (value) => {
          this.plugin.settings.aiEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsAiBaseUrl)
      .setDesc(t.settingsAiBaseUrlDesc)
      .addText((text) =>
        text.setValue(s.aiBaseUrl).onChange(async (value) => {
          this.plugin.settings.aiBaseUrl = value.trim() || DEFAULT_SETTINGS.aiBaseUrl;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsAiProvider)
      .setDesc(t.settingsAiProviderDesc)
      .addDropdown((dropdown) => {
        for (const provider of AI_PROVIDERS) {
          dropdown.addOption(provider, t.aiProviderLabel(provider));
        }
        dropdown
          .setValue(s.aiProvider)
          .onChange(async (value) => {
            const provider = value as AiProvider;
            this.plugin.settings.aiProvider = provider;
            const models = allModelsForProvider(provider, this.plugin.settings);
            if (!models.includes(this.plugin.settings.aiModel)) {
              this.plugin.settings.aiModel = models[0] ?? defaultModelForProvider(provider);
            }
            await this.plugin.saveSettings();
            this.renderSettings();
          });
      });

    new Setting(containerEl)
      .setName(t.settingsAiModel)
      .setDesc(t.settingsAiModelDesc)
      .addDropdown((dropdown) => {
        const models = allModelsForProvider(s.aiProvider, s);
        for (const model of models) {
          dropdown.addOption(model, model);
        }
        dropdown.setValue(models.includes(s.aiModel) ? s.aiModel : (models[0] ?? s.aiModel));
        dropdown.onChange(async (value) => {
          this.plugin.settings.aiModel = value;
          await this.plugin.saveSettings();
        });
      });

    for (const provider of AI_PROVIDERS) {
      new Setting(containerEl)
        .setName(t.settingsAiCustomModels(t.aiProviderLabel(provider)))
        .setDesc(t.settingsAiCustomModelsDesc)
        .addTextArea((area) => {
          area
            .setValue(customModelsToText(s.aiCustomModels[provider]))
            .onChange(async (value) => {
              this.plugin.settings.aiCustomModels[provider] = parseCustomModels(value);
              const models = allModelsForProvider(provider, this.plugin.settings);
              if (
                this.plugin.settings.aiProvider === provider &&
                !models.includes(this.plugin.settings.aiModel)
              ) {
                this.plugin.settings.aiModel = models[0] ?? this.plugin.settings.aiModel;
              }
              await this.plugin.saveSettings();
              this.renderSettings();
            });
          area.inputEl.rows = 4;
          area.inputEl.addClass('vault-finder-prompt-area');
        });
    }

    new Setting(containerEl)
      .setName(t.settingsAiApiKey)
      .setDesc(t.settingsAiApiKeyDesc)
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(s.aiApiKey).onChange(async (value) => {
          this.plugin.settings.aiApiKey = value;
          await this.plugin.saveSettings();
        });
      });

    this.addPromptSetting(
      containerEl,
      t.settingsAiKeywordPrompt,
      t.settingsAiKeywordPromptDesc,
      s.aiKeywordPrompt,
      defaultKeywordPrompt(s.language),
      async (value) => {
        this.plugin.settings.aiKeywordPrompt = value;
        await this.plugin.saveSettings();
      },
    );

    this.addPromptSetting(
      containerEl,
      t.settingsAiResultPrompt,
      t.settingsAiResultPromptDesc,
      s.aiResultPrompt,
      defaultResultPrompt(s.language),
      async (value) => {
        this.plugin.settings.aiResultPrompt = value;
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName(t.settingsAiFilterIrrelevant)
      .setDesc(t.settingsAiFilterIrrelevantDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.aiFilterIrrelevantResults).onChange(async (value) => {
          this.plugin.settings.aiFilterIrrelevantResults = value;
          await this.plugin.saveSettings();
        }),
      );

    this.addPromptSetting(
      containerEl,
      t.settingsAiRelevancePrompt,
      t.settingsAiRelevancePromptDesc,
      s.aiRelevancePrompt,
      defaultRelevancePrompt(s.language),
      async (value) => {
        this.plugin.settings.aiRelevancePrompt = value;
        await this.plugin.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName(t.settingsAiMaxHits)
      .setDesc(t.settingsAiMaxHitsDesc)
      .addText((text) =>
        text.setValue(String(s.aiMaxHitsForPrompt)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n) || n < 1) return;
          this.plugin.settings.aiMaxHitsForPrompt = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsAiMaxSnippet)
      .setDesc(t.settingsAiMaxSnippetDesc)
      .addText((text) =>
        text.setValue(String(s.aiMaxSnippetChars)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n) || n < 50) return;
          this.plugin.settings.aiMaxSnippetChars = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsAiTimeout)
      .setDesc(t.settingsAiTimeoutDesc)
      .addText((text) =>
        text.setValue(String(Math.round(s.aiTimeoutMs / 1000))).onChange(async (value) => {
          const sec = Number.parseInt(value, 10);
          if (Number.isNaN(sec) || sec < 5) return;
          this.plugin.settings.aiTimeoutMs = sec * 1000;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsAiFallback)
      .setDesc(t.settingsAiFallbackDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.aiFallbackToLocal).onChange(async (value) => {
          this.plugin.settings.aiFallbackToLocal = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName(t.settingsAdvanced).setHeading();

    new Setting(containerEl)
      .setName(t.settingsDebounce)
      .setDesc(t.settingsDebounceDesc)
      .addText((text) =>
        text.setValue(String(s.searchDebounceMs)).onChange(async (value) => {
          const ms = Number.parseInt(value, 10);
          if (Number.isNaN(ms) || ms < 0) return;
          this.plugin.settings.searchDebounceMs = ms;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsMaxResults)
      .setDesc(t.settingsMaxResultsDesc)
      .addText((text) =>
        text.setValue(String(s.maxResults)).onChange(async (value) => {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n) || n < 1) return;
          this.plugin.settings.maxResults = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsMatchThreshold)
      .setDesc(t.settingsMatchThresholdDesc)
      .addText((text) =>
        text.setValue(String(s.searchMatchThreshold)).onChange(async (value) => {
          const n = clampMatchThreshold(Number.parseInt(value, 10));
          this.plugin.settings.searchMatchThreshold = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.settingsShowWeakMatches)
      .setDesc(t.settingsShowWeakMatchesDesc)
      .addToggle((toggle) =>
        toggle.setValue(s.showWeakMatchResults).onChange(async (value) => {
          this.plugin.settings.showWeakMatchResults = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private formatIndexStatus(): string {
    const t = this.plugin.t();
    const status = this.plugin.index.getStatus();
    return t.settingsIndexStatusValue(
      status.documentCount,
      status.isRebuilding,
      status.vectorDocumentCount,
      status.isVectorBuilding,
    );
  }

  private addPromptSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: string,
    defaultValue: string,
    onSave: (value: string) => Promise<void>,
  ): void {
    const t = this.plugin.t();
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addButton((btn) =>
        btn.setButtonText(t.settingsAiResetPrompt).onClick(async () => {
          await onSave(defaultValue);
          this.renderSettings();
        }),
      );

    new Setting(containerEl).addTextArea((area) => {
      area.setValue(value).onChange(async (v) => {
        const trimmed = v.trim();
        await onSave(trimmed.length > 0 ? v : defaultValue);
      });
      area.inputEl.rows = 6;
      area.inputEl.addClass('vault-finder-prompt-area');
    });
  }
}
