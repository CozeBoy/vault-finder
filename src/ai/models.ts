import type { AiProvider, VaultFinderSettings } from '../settings';
import { modelsForProvider } from '../settings';

export function parseCustomModels(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function customModelsToText(models: string[]): string {
  return models.join('\n');
}

export function allModelsForProvider(
  provider: AiProvider,
  settings: VaultFinderSettings,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const model of modelsForProvider(provider)) {
    if (!seen.has(model)) {
      seen.add(model);
      result.push(model);
    }
  }

  for (const model of settings.aiCustomModels[provider] ?? []) {
    const trimmed = model.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}

export function normalizeCustomModels(
  input: Partial<Record<AiProvider, string[]>> | undefined,
): Record<AiProvider, string[]> {
  return {
    OpenAI: input?.OpenAI ?? [],
    Anthropic: input?.Anthropic ?? [],
    Gemini: input?.Gemini ?? [],
    Compatible: input?.Compatible ?? [],
  };
}
