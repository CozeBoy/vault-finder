import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import type { VaultFinderSettings, AiProvider } from '../settings';
import { modelsForProvider } from '../settings';
import type { SearchHit } from '../index/types';

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

  private async chat(
    systemPrompt: string,
    userContent: string,
    settings: VaultFinderSettings,
  ): Promise<string> {
    const baseUrl = settings.aiBaseUrl.replace(/\/+$/, '');
    const timeout = settings.aiTimeoutMs;

    switch (settings.aiProvider) {
      case 'OpenAI':
        return this.openAiChat(baseUrl, systemPrompt, userContent, settings.aiModel, settings.aiApiKey, timeout);
      case 'Anthropic':
        return this.anthropicChat(baseUrl, systemPrompt, userContent, settings.aiModel, settings.aiApiKey, timeout);
      case 'Gemini':
        return this.geminiChat(baseUrl, systemPrompt, userContent, settings.aiModel, settings.aiApiKey, timeout);
    }
  }

  private async openAiChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
  ): Promise<string> {
    const res = await requestWithTimeout(
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
    );
    if (res.status >= 400) throw new Error(`OpenAI error ${res.status}`);
    const json: unknown = res.json;
    return extractOpenAiText(json);
  }

  private async anthropicChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
  ): Promise<string> {
    const res = await requestWithTimeout(
      {
        url: `${baseUrl}/v1/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        throw: false,
      },
      timeout,
    );
    if (res.status >= 400) throw new Error(`Anthropic error ${res.status}`);
    return extractAnthropicText(res.json);
  }

  private async geminiChat(
    baseUrl: string,
    system: string,
    user: string,
    model: string,
    apiKey: string,
    timeout: number,
  ): Promise<string> {
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await requestWithTimeout(
      {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
        throw: false,
      },
      timeout,
    );
    if (res.status >= 400) throw new Error(`Gemini error ${res.status}`);
    return extractGeminiText(res.json);
  }
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
    // try to extract JSON array from response
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
  const message = choices[0] as { message?: { content?: string } };
  return message.message?.content?.trim() ?? '';
}

function extractAnthropicText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const block = content[0] as { text?: string };
  return block.text?.trim() ?? '';
}

function extractGeminiText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return '';
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  if (!Array.isArray(parts)) return '';
  const part = parts[0] as { text?: string };
  return part.text?.trim() ?? '';
}

export function providerOptions(provider: AiProvider): string[] {
  return [...modelsForProvider(provider)];
}

async function requestWithTimeout(
  params: RequestUrlParam,
  timeoutMs: number,
): Promise<RequestUrlResponse> {
  if (timeoutMs <= 0) return requestUrl(params);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
  });

  try {
    return await Promise.race([requestUrl(params), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
