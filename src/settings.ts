import { resolveLanguage } from './i18n';

export type LanguageSetting = 'auto' | 'zh-CN' | 'en';
export type AiProvider = 'OpenAI' | 'Anthropic' | 'Gemini';

export interface VaultFinderSettings {
  language: LanguageSetting;
  showRibbonIcon: boolean;
  indexableExtensions: string[];
  excludePaths: string[];
  maxFileSizeBytes: number;
  searchDebounceMs: number;
  maxResults: number;
  /** Minimum match percent (1–100) for primary results; default 80 */
  searchMatchThreshold: number;
  showWeakMatchResults: boolean;

  aiEnabled: boolean;
  aiBaseUrl: string;
  aiProvider: AiProvider;
  aiModel: string;
  aiApiKey: string;
  aiKeywordPrompt: string;
  aiResultPrompt: string;
  aiRelevancePrompt: string;
  aiFilterIrrelevantResults: boolean;
  aiMaxHitsForPrompt: number;
  aiMaxSnippetChars: number;
  aiTimeoutMs: number;
  aiFallbackToLocal: boolean;
  aiCustomModels: Record<AiProvider, string[]>;

  vectorSearchEnabled: boolean;
  vectorBaseUrl: string;
  vectorApiKey: string;
  embeddingModel: string;
  vectorCustomEmbeddingModels: string[];
  vectorEmbedMaxChars: number;
  vectorMinScore: number;
  vectorTimeoutMs: number;
  /** Parallel embedding API requests when building vector index */
  vectorEmbedConcurrency: number;
  /** Vault-relative folder path; empty uses plugin-dir/vector-cache */
  vectorCacheFolder: string;
  /** Vault-relative folder path; empty uses plugin-dir/keyword-cache */
  keywordCacheFolder: string;
}

export const VECTOR_EMBED_CONCURRENCY_MIN = 1;
export const VECTOR_EMBED_CONCURRENCY_MAX = 32;

export const EMBEDDING_MODELS = [
  'text-embedding-3-small',
  'text-embedding-3-large',
  'Qwen/Qwen3-Reranker-0.6B',
  'Pro/BAAI/bge-reranker-v2-m3',
  'netease-youdao/bce-reranker-base_v1',
  'BAAI/bge-reranker-v2-m3',
  'Embedding-V1',
  'qwen3-rerank',
  'gemini-embedding-001',
  'gemini-embedding-2-preview',
] as const;

export const DEFAULT_KEYWORD_PROMPT_ZH = `你是一个知识库检索助手。用户将在 Obsidian 笔记库中搜索内容。
根据用户的查询，输出 3～8 个用于全文检索的关键词或短语，包括：
- 同义词与近义表达
- 上下位概念
- 中英混合关键词（若适用）

只输出 JSON 数组，例如：["关键词1", "关键词2"]
不要输出解释或其他格式。`;

export const DEFAULT_RESULT_PROMPT_ZH = `你是知识库搜索结果整理助手。根据用户查询和以下搜索命中条目（含文件路径与片段），撰写一篇逻辑通顺、结构完整的 Markdown 文章。

写作要求：
1. 必须包含完整章节结构：
   - 一级标题 # 文章标题（概括主题）
   - 二级标题 ## 章节（至少 2～4 个，如：概述、核心发现、详细分析、参考来源）
   - 三级标题 ### 小节（按需拆分，保证层次清晰）
2. 段落之间衔接自然，整体读下来是一篇连贯的文章，而非条目堆砌
3. 仅整合下方真实命中内容，不得编造知识库中不存在的信息
4. 引用来源时使用 [[文件路径]] 或 [[标题]] 格式，便于跳转
5. 若命中内容与查询关联较弱，在独立章节中如实说明「未找到强相关内容」

只输出文章正文（Markdown），不要输出 JSON 或其他格式。`;

export const DEFAULT_RELEVANCE_PROMPT_ZH = `你是搜索结果相关性评估助手。根据用户查询，判断每条命中是否与查询主题真正相关。

评估标准：
- 片段内容是否直接回答或支撑用户查询
- 标题与路径是否与查询意图一致
- 排除仅因关键词偶然匹配、主题明显无关的条目

只输出 JSON 数组，包含相关条目的序号（与下方列表编号一致），例如：[1, 3, 5]
若全部不相关输出 []。不要输出解释或其他格式。`;

export const DEFAULT_KEYWORD_PROMPT_EN = `You are a knowledge base search assistant. The user will search their Obsidian vault.

Based on the user's query, output 3–8 keywords or phrases for full-text search, including:
- Synonyms and near-equivalent terms
- Broader and narrower concepts
- Mixed Chinese/English keywords when applicable

Output only a JSON array, e.g.: ["keyword1", "keyword2"]
Do not output explanations or any other format.`;

export const DEFAULT_RESULT_PROMPT_EN = `You are a search results synthesis assistant. Given the user's query and the hit list below (file paths and snippets), write a coherent, well-structured Markdown article.

Requirements:
1. Use a full document structure:
   - One # title summarizing the topic
   - At least 2–4 ## sections (e.g. Overview, Key findings, Detailed analysis, References)
   - ### subsections as needed for clear hierarchy
2. Paragraphs should flow naturally as one article, not a bullet dump
3. Only synthesize real hits below; do not invent facts not present in the vault
4. Cite sources as [[file path]] or [[title]] for navigation
5. If hits are weakly related, state that clearly in a dedicated section

Output only the article body (Markdown). No JSON or other formats.`;

export const DEFAULT_RELEVANCE_PROMPT_EN = `You are a search relevance evaluator. For each hit below, decide whether it truly relates to the user's query.

Criteria:
- Does the snippet directly answer or support the query?
- Do title and path match the user's intent?
- Exclude hits that only match keywords accidentally or are clearly off-topic

Output only a JSON array of relevant hit numbers (matching the list below), e.g.: [1, 3, 5]
If none are relevant, output []. No explanations or other formats.`;

/** @deprecated Use defaultKeywordPrompt(language) */
export const DEFAULT_KEYWORD_PROMPT = DEFAULT_KEYWORD_PROMPT_ZH;
/** @deprecated Use defaultResultPrompt(language) */
export const DEFAULT_RESULT_PROMPT = DEFAULT_RESULT_PROMPT_ZH;
/** @deprecated Use defaultRelevancePrompt(language) */
export const DEFAULT_RELEVANCE_PROMPT = DEFAULT_RELEVANCE_PROMPT_ZH;

export function defaultKeywordPrompt(language: LanguageSetting): string {
  return resolveLanguage(language) === 'zh-CN'
    ? DEFAULT_KEYWORD_PROMPT_ZH
    : DEFAULT_KEYWORD_PROMPT_EN;
}

export function defaultResultPrompt(language: LanguageSetting): string {
  return resolveLanguage(language) === 'zh-CN'
    ? DEFAULT_RESULT_PROMPT_ZH
    : DEFAULT_RESULT_PROMPT_EN;
}

export function defaultRelevancePrompt(language: LanguageSetting): string {
  return resolveLanguage(language) === 'zh-CN'
    ? DEFAULT_RELEVANCE_PROMPT_ZH
    : DEFAULT_RELEVANCE_PROMPT_EN;
}

function hasChineseDefaultPrompts(settings: VaultFinderSettings): boolean {
  return (
    settings.aiKeywordPrompt === DEFAULT_KEYWORD_PROMPT_ZH &&
    settings.aiResultPrompt === DEFAULT_RESULT_PROMPT_ZH &&
    settings.aiRelevancePrompt === DEFAULT_RELEVANCE_PROMPT_ZH
  );
}

function hasEnglishDefaultPrompts(settings: VaultFinderSettings): boolean {
  return (
    settings.aiKeywordPrompt === DEFAULT_KEYWORD_PROMPT_EN &&
    settings.aiResultPrompt === DEFAULT_RESULT_PROMPT_EN &&
    settings.aiRelevancePrompt === DEFAULT_RELEVANCE_PROMPT_EN
  );
}

/** Sync stored prompts to match UI language when still at factory defaults. Returns true if changed. */
export function syncPromptsToLanguage(settings: VaultFinderSettings): boolean {
  const locale = resolveLanguage(settings.language);
  if (locale === 'en' && hasChineseDefaultPrompts(settings)) {
    settings.aiKeywordPrompt = DEFAULT_KEYWORD_PROMPT_EN;
    settings.aiResultPrompt = DEFAULT_RESULT_PROMPT_EN;
    settings.aiRelevancePrompt = DEFAULT_RELEVANCE_PROMPT_EN;
    return true;
  }
  if (locale === 'zh-CN' && hasEnglishDefaultPrompts(settings)) {
    settings.aiKeywordPrompt = DEFAULT_KEYWORD_PROMPT_ZH;
    settings.aiResultPrompt = DEFAULT_RESULT_PROMPT_ZH;
    settings.aiRelevancePrompt = DEFAULT_RELEVANCE_PROMPT_ZH;
    return true;
  }
  return false;
}

export const OPENAI_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.3'] as const;
export const ANTHROPIC_MODELS = [
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-6',
  'claude-opus-4-5',
] as const;
export const GEMINI_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
] as const;

export const DEFAULT_SETTINGS: VaultFinderSettings = {
  language: 'auto',
  showRibbonIcon: true,
  indexableExtensions: ['md', 'txt', 'json', 'ini'],
  excludePaths: [],
  maxFileSizeBytes: 10 * 1024 * 1024,
  searchDebounceMs: 200,
  maxResults: 50,
  searchMatchThreshold: 80,
  showWeakMatchResults: true,

  aiEnabled: true,
  aiBaseUrl: 'https://api.aicso.top/',
  aiProvider: 'OpenAI',
  aiModel: 'gpt-5.5',
  aiApiKey: '',
  aiKeywordPrompt: DEFAULT_KEYWORD_PROMPT_ZH,
  aiResultPrompt: DEFAULT_RESULT_PROMPT_ZH,
  aiRelevancePrompt: DEFAULT_RELEVANCE_PROMPT_ZH,
  aiFilterIrrelevantResults: true,
  aiMaxHitsForPrompt: 20,
  aiMaxSnippetChars: 500,
  aiTimeoutMs: 600000,
  aiFallbackToLocal: true,
  aiCustomModels: {
    OpenAI: [],
    Anthropic: [],
    Gemini: [],
  },

  vectorSearchEnabled: true,
  vectorBaseUrl: 'https://api.aicso.top/v1/embeddings',
  vectorApiKey: '',
  embeddingModel: 'text-embedding-3-small',
  vectorCustomEmbeddingModels: [],
  vectorEmbedMaxChars: 4000,
  vectorMinScore: 0.25,
  vectorTimeoutMs: 600000,
  vectorEmbedConcurrency: 10,
  vectorCacheFolder: '',
  keywordCacheFolder: '',
};

export function clampVectorEmbedConcurrency(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_SETTINGS.vectorEmbedConcurrency;
  return Math.max(
    VECTOR_EMBED_CONCURRENCY_MIN,
    Math.min(VECTOR_EMBED_CONCURRENCY_MAX, Math.round(value)),
  );
}

export function isPartialSettings(data: unknown): data is Partial<VaultFinderSettings> {
  return typeof data === 'object' && data !== null;
}

export function normalizeExtensions(extensions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ext of extensions) {
    const normalized = ext.trim().toLowerCase().replace(/^\./, '');
    if (!normalized || seen.has(normalized)) continue;
    if (!/^[a-z0-9]+$/.test(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [...DEFAULT_SETTINGS.indexableExtensions];
}

export function modelsForProvider(provider: AiProvider): readonly string[] {
  switch (provider) {
    case 'OpenAI':
      return OPENAI_MODELS;
    case 'Anthropic':
      return ANTHROPIC_MODELS;
    case 'Gemini':
      return GEMINI_MODELS;
  }
}

export function defaultModelForProvider(provider: AiProvider): string {
  const models = modelsForProvider(provider);
  return models[0] ?? DEFAULT_SETTINGS.aiModel;
}

export function hasValidAiKey(settings: VaultFinderSettings): boolean {
  return settings.aiApiKey.trim().length > 0;
}

export function isAiActive(settings: VaultFinderSettings): boolean {
  return settings.aiEnabled && hasValidAiKey(settings);
}

export function hasValidVectorKey(settings: VaultFinderSettings): boolean {
  return settings.vectorApiKey.trim().length > 0;
}

export function isVectorActive(settings: VaultFinderSettings): boolean {
  return settings.vectorSearchEnabled && hasValidVectorKey(settings);
}

export function allEmbeddingModels(settings: VaultFinderSettings): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of EMBEDDING_MODELS) {
    if (!seen.has(model)) {
      seen.add(model);
      result.push(model);
    }
  }
  for (const model of settings.vectorCustomEmbeddingModels) {
    const trimmed = model.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function parseCustomEmbeddingModels(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}
