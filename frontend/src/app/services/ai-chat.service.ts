import { Injectable, inject, signal } from '@angular/core';
import { supabaseConfig } from '../../environments/supabase.config';
import { AiProviderId, UserConfigService } from './user-config.service';
import { ViewContextService } from './view-context.service';

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export type AiChatTheme = 'dark' | 'light';

const SYSTEM_PROMPT = `You are Kairo, an in-app trading assistant for a private Indian-markets P&L app.
Answer using the VIEW CONTEXT JSON. Prefer numbers already in that JSON. If something is missing, say so.
Do not invent trades, prices, or P&L. Keep answers concise and practical.
Dates and money in the context are the user's records, not live exchange data unless labelled as CMP.`;

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const CLAUDE_MODELS = ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022'];

@Injectable({ providedIn: 'root' })
export class AiChatService {
  private keys = inject(UserConfigService);
  private viewContext = inject(ViewContextService);

  readonly open = signal(false);
  readonly provider = signal<AiProviderId>(readLastProvider());
  readonly paneWidthPct = signal(readPaneWidth());
  readonly theme = signal<AiChatTheme>(readTheme());
  readonly messages = signal<AiChatMessage[]>([]);
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  private cursorAgentId: string | null = null;

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

  setPaneWidthPct(pct: number): void {
    const next = Math.min(78, Math.max(28, pct));
    this.paneWidthPct.set(next);
    try {
      localStorage.setItem('kairo.aiPaneWidthPct', String(Math.round(next)));
    } catch {
      /* ignore */
    }
  }

  toggleTheme(): void {
    const next: AiChatTheme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    try {
      localStorage.setItem('kairo.aiTheme', next);
    } catch {
      /* ignore */
    }
  }

  clearThread(): void {
    this.messages.set([]);
    this.error.set(null);
    this.cursorAgentId = null;
  }

  async send(userText: string): Promise<void> {
    const text = userText.trim();
    if (!text || this.sending()) return;

    this.sending.set(true);
    this.error.set(null);
    this.messages.update((rows) => [...rows, { role: 'user', content: text, at: Date.now() }]);

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
      this.messages.update((rows) => [...rows, { role: 'assistant', content: reply, at: Date.now() }]);
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
   * Cursor has no browser chat-completions API. We proxy the Cloud Agents
   * no-repo endpoint through a Supabase function to avoid CORS.
   */
  private async completeCursor(
    apiKey: string,
    system: string,
    history: AiChatMessage[]
  ): Promise<string> {
    const prompt = [
      system,
      'Reply in plain text only. Do not create or edit files.',
      '',
      ...history.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`),
    ].join('\n');

    let agentId = this.cursorAgentId;
    let result = await this.cursorProxy({
      action: 'start',
      apiKey,
      prompt,
      agentId: agentId ?? undefined,
    });

    for (let i = 0; i < 40 && result.status === 'RUNNING'; i++) {
      await sleep(2000);
      result = await this.cursorProxy({
        action: 'poll',
        apiKey,
        agentId: result.agentId,
        runId: result.runId,
      });
    }

    if (result.agentId) this.cursorAgentId = result.agentId;
    if (result.error) throw new Error(result.error);
    if (result.status === 'RUNNING') {
      throw new Error('Cursor is still working. Ask again in a moment — the same thread will continue.');
    }
    const text = (result.text ?? '').trim();
    if (!text) throw new Error('Cursor returned an empty reply.');
    return text;
  }

  private async cursorProxy(payload: {
    action: 'start' | 'poll';
    apiKey: string;
    prompt?: string;
    agentId?: string;
    runId?: string;
  }): Promise<{ status: string; agentId?: string; runId?: string; text?: string; error?: string }> {
    const res = await fetch(`${supabaseConfig.url}/functions/v1/cursor-chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (!res) {
      throw new Error('Could not reach the Cursor proxy. Try again, or use Gemini.');
    }
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      agentId?: string;
      runId?: string;
      text?: string;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? body.message ?? `Cursor proxy failed (${res.status})`);
    }
    return {
      status: body.status ?? 'ERROR',
      agentId: body.agentId,
      runId: body.runId,
      text: body.text,
      error: body.error,
    };
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

function readPaneWidth(): number {
  try {
    const raw = Number(localStorage.getItem('kairo.aiPaneWidthPct'));
    if (Number.isFinite(raw) && raw >= 28 && raw <= 78) return raw;
  } catch {
    /* ignore */
  }
  return 50;
}

function readTheme(): AiChatTheme {
  try {
    const value = localStorage.getItem('kairo.aiTheme');
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
