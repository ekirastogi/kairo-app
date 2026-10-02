import { Injectable, inject, signal } from '@angular/core';
import { AiProviderId, UserConfigService } from './user-config.service';
import { ViewContextService } from './view-context.service';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are Kairo, an in-app trading assistant for a private Indian-markets P&L app.
Answer using the VIEW CONTEXT JSON. Prefer numbers already in that JSON. If something is missing, say so.
Do not invent trades, prices, or P&L. Keep answers concise and practical.
Dates and money in the context are the user's records, not live exchange data unless labelled as CMP.`;

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const CLAUDE_MODELS = ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022'];
const CURSOR_MODELS = ['composer-2', 'composer-1', 'gpt-5'];

@Injectable({ providedIn: 'root' })
export class AiChatService {
  private keys = inject(UserConfigService);
  private viewContext = inject(ViewContextService);

  readonly open = signal(false);
  readonly provider = signal<AiProviderId>(readLastProvider());
  readonly messages = signal<AiChatMessage[]>([]);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);

  toggle(): void {
    this.open.update((open) => !open);
    if (this.open()) this.error.set(null);
  }

  close(): void {
    this.open.set(false);
  }

  setProvider(provider: AiProviderId): void {
    this.provider.set(provider);
    try {
      localStorage.setItem('kairo.aiProvider', provider);
    } catch {
      /* ignore */
    }
    this.error.set(null);
  }

  clearThread(): void {
    this.messages.set([]);
    this.error.set(null);
  }

  async send(userText: string): Promise<void> {
    const text = userText.trim();
    if (!text || this.sending()) return;

    this.sending.set(true);
    this.error.set(null);
    this.messages.update((rows) => [...rows, { role: 'user', content: text }]);

    try {
      const provider = this.provider();
      const apiKey = await this.keys.getAiApiKey(provider);
      if (!apiKey) {
        throw new Error(
          `Add your ${providerLabel(provider)} API key in Settings → AI keys, then try again.`
        );
      }
      const history = this.messages();
      const reply = await this.complete(provider, apiKey, history);
      this.messages.update((rows) => [...rows, { role: 'assistant', content: reply }]);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The model could not answer.';
      this.error.set(message);
      this.messages.update((rows) => {
        const last = rows[rows.length - 1];
        return last?.role === 'user' && last.content === text ? rows.slice(0, -1) : rows;
      });
    } finally {
      this.sending.set(false);
    }
  }

  private async complete(
    provider: AiProviderId,
    apiKey: string,
    history: AiChatMessage[]
  ): Promise<string> {
    const context = this.viewContext.forModel();
    const system = `${SYSTEM_PROMPT}\n\nVIEW CONTEXT JSON:\n${context}`;
    if (provider === 'gemini') return this.completeGemini(apiKey, system, history);
    if (provider === 'claude') return this.completeClaude(apiKey, system, history);
    return this.completeCursor(apiKey, system, history);
  }

  private async completeGemini(
    apiKey: string,
    system: string,
    history: AiChatMessage[]
  ): Promise<string> {
    const contents = history.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));
    let lastError = 'Gemini request failed';
    for (const model of GEMINI_MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents,
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
          }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = extractGeminiText(body);
        if (text) return text;
        lastError = 'Gemini returned an empty reply.';
        continue;
      }
      lastError = apiErrorMessage(body, `Gemini ${model} (${res.status})`);
      if (res.status === 401 || res.status === 403) break;
    }
    throw new Error(lastError);
  }

  private async completeClaude(
    apiKey: string,
    system: string,
    history: AiChatMessage[]
  ): Promise<string> {
    let lastError = 'Claude request failed';
    for (const model of CLAUDE_MODELS) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0.3,
          system,
          messages: history.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = extractClaudeText(body);
        if (text) return text;
        lastError = 'Claude returned an empty reply.';
        continue;
      }
      lastError = apiErrorMessage(body, `Claude ${model} (${res.status})`);
      if (res.status === 401 || res.status === 403) break;
      if (looksLikeCors(res, body)) {
        throw new Error(
          'Claude blocked this browser request (CORS). Use Gemini for in-app chat, or call Claude from a backend later.'
        );
      }
    }
    throw new Error(lastError);
  }

  /**
   * Cursor's published SDK (@cursor/sdk) is a Node coding-agent runtime, not a browser LLM.
   * We still store the Cursor key encrypted and try the HTTP chat surface when present.
   */
  private async completeCursor(
    apiKey: string,
    system: string,
    history: AiChatMessage[]
  ): Promise<string> {
    const payload = {
      messages: [{ role: 'system', content: system }, ...history],
      temperature: 0.3,
      max_tokens: 2048,
    };
    let lastError =
      'Cursor in-browser chat is not available. Your key is saved encrypted; use Gemini or Claude for Ask AI.';
    for (const model of CURSOR_MODELS) {
      const res = await fetch('https://api.cursor.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, model }),
      }).catch(() => null);
      if (!res) {
        lastError =
          'Could not reach Cursor from the browser. Use Gemini or Claude for Ask AI. Your Cursor key stays saved for agents.';
        break;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = extractOpenAiText(body);
        if (text) return text;
        lastError = 'Cursor returned an empty reply.';
        continue;
      }
      lastError = apiErrorMessage(body, `Cursor (${res.status})`);
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        throw new Error(
          'Cursor chat is not exposed to this app. The key is stored encrypted; pick Gemini or Claude to ask about this view.'
        );
      }
    }
    throw new Error(lastError);
  }
}

function providerLabel(provider: AiProviderId): string {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'claude') return 'Claude';
  return 'Cursor';
}

function readLastProvider(): AiProviderId {
  try {
    const value = localStorage.getItem('kairo.aiProvider');
    if (value === 'gemini' || value === 'claude' || value === 'cursor') return value;
  } catch {
    /* ignore */
  }
  return 'gemini';
}

function extractGeminiText(body: unknown): string {
  const candidates = (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates;
  const text = candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  return text.trim();
}

function extractClaudeText(body: unknown): string {
  const blocks = (body as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim();
}

function extractOpenAiText(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices;
  return (choices?.[0]?.message?.content ?? '').trim();
}

function apiErrorMessage(body: unknown, fallback: string): string {
  const err = body as {
    error?: { message?: string } | string;
    message?: string;
  };
  if (typeof err?.error === 'string' && err.error.trim()) return err.error;
  if (typeof err?.error === 'object' && err.error?.message) return err.error.message;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message;
  return fallback;
}

function looksLikeCors(res: Response, body: unknown): boolean {
  return res.status === 0 || (!body && res.status >= 400);
}
