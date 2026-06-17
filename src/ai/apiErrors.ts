import type { RequestUrlResponse } from 'obsidian';
import { parseRequestResponse, type ParsedRequestResponse } from './requestResponse';

const MAX_ERROR_LENGTH = 480;

export function truncateErrorMessage(message: string, max = MAX_ERROR_LENGTH): string {
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function extractFromRecord(record: Record<string, unknown>): string | null {
  const direct = readStringField(record, 'message') ?? readStringField(record, 'msg');
  if (direct) return direct;

  const detail = record.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();

  const type = readStringField(record, 'type');
  const code = readStringField(record, 'code');
  if (type && code) return `${type} (${code})`;
  if (type) return type;
  if (code) return code;

  const status = readStringField(record, 'status');
  if (status) return status;

  return null;
}

export function extractErrorMessage(json: unknown, fallbackText: string): string {
  if (typeof json === 'string' && json.trim()) {
    try {
      return extractErrorMessage(JSON.parse(json) as unknown, fallbackText);
    } catch {
      return truncateErrorMessage(json);
    }
  }

  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;

    const nested = record.error;
    if (typeof nested === 'string' && nested.trim()) {
      return truncateErrorMessage(nested);
    }
    if (typeof nested === 'object' && nested !== null) {
      const nestedMessage = extractFromRecord(nested as Record<string, unknown>);
      if (nestedMessage) return truncateErrorMessage(nestedMessage);
    }

    const topLevel = extractFromRecord(record);
    if (topLevel) return truncateErrorMessage(topLevel);

    const errors = record.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0];
      if (typeof first === 'string' && first.trim()) {
        return truncateErrorMessage(first);
      }
      if (typeof first === 'object' && first !== null) {
        const nestedMessage = extractFromRecord(first as Record<string, unknown>);
        if (nestedMessage) return truncateErrorMessage(nestedMessage);
      }
    }

    const promptFeedback = record.promptFeedback;
    if (typeof promptFeedback === 'object' && promptFeedback !== null) {
      const blockReason = readStringField(promptFeedback as Record<string, unknown>, 'blockReason');
      if (blockReason) return truncateErrorMessage(`blocked: ${blockReason}`);
    }
  }

  if (fallbackText.trim()) {
    const trimmed = fallbackText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractErrorMessage(JSON.parse(trimmed) as unknown, '');
      } catch {
        return truncateErrorMessage(trimmed);
      }
    }
    return truncateErrorMessage(trimmed);
  }

  return 'Unknown API error';
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return truncateErrorMessage(error.message);
  }
  if (typeof error === 'string' && error.trim()) {
    return truncateErrorMessage(error);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return truncateErrorMessage(message);
    }
  }
  const text = String(error);
  return text.trim() ? truncateErrorMessage(text) : 'Unknown error';
}

export function aiErrorNotice(prefix: string, error: unknown): string {
  const detail = aiErrorMessage(error);
  if (!detail || detail === 'Unknown error') {
    return prefix;
  }
  return `${prefix}: ${detail}`;
}

export function assertHttpOk(
  provider: string,
  status: number,
  json: unknown,
  text: string,
): void {
  if (status < 400) return;
  throw new Error(`${provider} HTTP ${status}: ${extractErrorMessage(json, text)}`);
}

export function assertResponseOk(provider: string, res: RequestUrlResponse): ParsedRequestResponse {
  const payload = parseRequestResponse(res);
  assertHttpOk(provider, res.status, payload.json, payload.text);
  return payload;
}

export function describeEmptyResponse(provider: string, json: unknown): string {
  if (typeof json !== 'object' || json === null) {
    return `${provider} returned an empty response`;
  }

  const record = json as Record<string, unknown>;
  const parts: string[] = [`${provider} returned an empty response`];

  const finishReason = readStringField(record, 'stop_reason');
  if (finishReason) parts.push(`stop_reason=${finishReason}`);

  const candidates = record.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0];
    if (typeof first === 'object' && first !== null) {
      const reason = readStringField(first as Record<string, unknown>, 'finishReason');
      if (reason) parts.push(`finishReason=${reason}`);
    }
  }

  const hint = extractErrorMessage(json, '');
  if (hint && hint !== 'Unknown API error') {
    parts.push(hint);
  }

  return parts.join('; ');
}

export function assertNonEmptyResponse(provider: string, content: string, json: unknown): void {
  if (content.trim()) return;
  throw new Error(describeEmptyResponse(provider, json));
}
