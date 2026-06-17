import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import type { VaultFinderSettings, AiProvider } from '../settings';
import { modelsForProvider } from '../settings';
import type { SearchHit } from '../index/types';
import {
  aiErrorMessage,
  assertNonEmptyResponse,
  assertResponseOk,
} from './apiErrors';

const DEFAULT_REFINE_PROMPT = `你是知识库检索综述优化助手。根据用户的优化要求，在保留事实准确性的前提下改写下方 Markdown 综述。
要求：
1. 保持 Markdown 结构与章节层次清晰
2. 不得编造原文中没有的信息
3. 若原文包含 [[文件路径]] 引用，按需保留或精简
4. 只输出优化后的正文（Markdown），不要输出解释或其他格式`;

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MAX_OUTPUT_TOKENS = 16384;
const GEMINI_MAX_OUTPUT_TOKENS = 16384;

export class AiService {
  constructor(private getSettings: () => VaultFinderSettings) {}

  async expandKeywords(query: string): Promise<string[]> {
    const settings = this.getSettings();
    const content = `用户查询：${query}`;
    const response = await this.chat(settings.aiKeywordPrompt, content, settings);
    return parseKeywordArray(response);
  }

  async optimizeResults(query: string, hits: SearchHit[]): Promise<string> {
    const settings = this.getSettings();
    const limited = hits.slice(0, settings.aiMaxHitsForPrompt);
    const payload = limited
      .map((hit, i) => {
        const snippet = hit.snippet.slice(0, settings.aiMaxSnippetChars);
        return `${i + 1}. 路径: ${hit.path}\n片段: ${snippet}`;
      })
      .join('\n\n');

    const content = `用户查询：${query}\n\n搜索命中条目：\n${payload}`;
    return this.chat(settings.aiResultPrompt, content, settings);
  }

  async filterRelevantHits(query: string, hits: SearchHit[]): Promise<SearchHit[]> {
    const settings = this.getSettings();
    if (hits.length === 0) return hits;

    const limited = hits.slice(0, settings.aiMaxHitsForPrompt);
    const payload = limited
      .map((hit, i) => {
        const snippet = hit.snippet.slice(0, settings.aiMaxSnippetChars);
        return `${i + 1}. 路径: ${hit.path}\n标题: ${hit.title}\n片段: ${snippet}`;
      })
      .join('\n\n');

    const content = `用户查询：${query}\n\n命中条目：\n${payload}`;
    const response = await this.chat(settings.aiRelevancePrompt, content, settings);
    const trimmed = response.trim();
    if (/^\[\s*\]$/.test(trimmed)) return [];
    const keepIndices = parseRelevanceIndices(response);
    if (keepIndices.length === 0) return hits;
    const kept = limited.filter((_, i) => keepIndices.includes(i + 1));
    const rest = hits.slice(limited.length);
    return [...kept, ...rest];
  }

  async refineArticle(
    instruction: string,
    article: string,
    query: string,
    options?: { provider?: AiProvider; model?: string },
  ): Promise<string> {
    const settings = this.getSettings();
    const effective: VaultFinderSettings = {
      ...settings,
      aiProvider: options?.provider ?? settings.aiProvider,
      aiModel: options?.model ?? settings.aiModel,
    };
    const content = `用户查询：${query}\n\n当前综述内容：\n${article}\n\n优化要求：\n${instruction}`;
    return this.chat(DEFAULT_REFINE_PROMPT, content, effective);
  }

  private async chat(
    systemPrompt: string,
    userContent: string,
    settings: VaultFinderSettings,
  ): Promise<string> {
    const baseUrl = settings.aiBaseUrl.replace(/\/+$/, '');
    const timeout = settings.aiTimeoutMs;
    const { aiProvider, aiModel, aiApiKey } = settings;

    switch (aiProvider) {
      case 'OpenAI':
      case 'Compatible':
        return this.openAiChat(
          baseUrl,
          systemPrompt,
          userContent,
          aiModel,
          aiApiKey,
          timeout,
          aiProvider,
        );
      case 'Anthropic':
        return this.anthropicChat(baseUrl, systemPrompt, userContent, aiModel, aiApiKey, timeout);
      case 'Gemini':
        return this.geminiChat(baseUrl, systemPrompt, userContent, aiModel, aiApiKey, timeout);
    }
  }

  private async openAiChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
    providerLabel: AiProvider = 'OpenAI',
  ): Promise<string> {
    const res = await safeRequest(
      {
        url: `${baseUrl}/v1/chat/completions`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        throw: false,
      },
      timeout,
      providerLabel,
    );
    const payload = assertResponseOk(providerLabel, res);
    const text = extractOpenAiText(payload.json);
    assertNonEmptyResponse(providerLabel, text, payload.json);
    return text;
  }

  private async anthropicChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
  ): Promise<string> {
    const res = await safeRequest(
      {
        url: `${baseUrl}/v1/messages`,
        method: 'POST',
        headers: buildAnthropicHeaders(apiKey, baseUrl),
        body: JSON.stringify({
          model,
          max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
          system,
          messages: [
            {
              role: 'user',
              content: user,
            },
          ],
        }),
        throw: false,
      },
      timeout,
      'Anthropic',
    );
    const payload = assertResponseOk('Anthropic', res);
    const text = extractAnthropicText(payload.json);
    assertNonEmptyResponse('Anthropic', text, payload.json);
    return text;
  }

  private async geminiChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
  ): Promise<string> {
    const { url, headers } = buildGeminiRequest(baseUrl, model, apiKey);
    const res = await safeRequest(
      {
        url,
        method: 'POST',
        headers,
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: system }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: user }],
            },
          ],
          generationConfig: {
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          },
        }),
        throw: false,
      },
      timeout,
      'Gemini',
    );
    const payload = assertResponseOk('Gemini', res);
    const text = extractGeminiText(payload.json);
    assertNonEmptyResponse('Gemini', text, payload.json);
    return text;
  }
}

function buildAnthropicHeaders(apiKey: string, baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (/anthropic\.com/i.test(baseUrl)) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

function buildGeminiRequest(
  baseUrl: string,
  model: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const root = baseUrl.replace(/\/+$/, '');
  const url = `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (/googleapis\.com/i.test(root)) {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return { url, headers };
}

function parseRelevanceIndices(text: string): number[] {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is number => typeof item === 'number' && item > 0);
    }
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is number => typeof item === 'number' && item > 0);
        }
      } catch {
        // fall through
      }
    }
  }
  return [];
}

function parseKeywordArray(text: string): string[] {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
        }
      } catch {
        // fall through
      }
    }
  }
  return trimmed
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractOpenAiText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return extractTextContent(message?.content).trim();
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join('');
}

function extractAnthropicText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';

  const record = json as Record<string, unknown>;

  const content = record.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  const fromBlocks = extractTextContent(content).trim();
  if (fromBlocks) return fromBlocks;

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    const fromOpenAiShim = extractTextContent(message?.content).trim();
    if (fromOpenAiShim) return fromOpenAiShim;
  }

  return '';
}

function extractGeminiText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  return extractTextContent(parts).trim();
}

export function providerOptions(provider: AiProvider): string[] {
  return [...modelsForProvider(provider)];
}

async function safeRequest(
  params: RequestUrlParam,
  timeoutMs: number,
  providerLabel: string,
): Promise<RequestUrlResponse> {
  try {
    return await requestWithTimeout(params, timeoutMs);
  } catch (error) {
    throw new Error(`${providerLabel}: ${aiErrorMessage(error)}`);
  }
}

async function requestWithTimeout(
  params: RequestUrlParam,
  timeoutMs: number,
): Promise<RequestUrlResponse> {
  if (timeoutMs <= 0) return requestUrl(params);

  let timer: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error('Request timeout')),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([requestUrl(params), timeoutPromise]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
