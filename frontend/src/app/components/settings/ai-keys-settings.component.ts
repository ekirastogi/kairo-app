import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiProviderId, UserConfigService } from '../../services/user-config.service';

@Component({
  selector: 'app-ai-keys-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-keys-settings.component.html',
})
export class AiKeysSettingsComponent implements OnInit {
  private userConfig = inject(UserConfigService);

  readonly rows: {
    id: AiProviderId;
    label: string;
    hint: string;
    hasKey: () => boolean;
  }[] = [
    {
      id: 'cursor',
      label: 'Cursor API key',
      hint: 'Optional. Not used for Ask AI — Cursor’s SDK is a coding-agent runtime, not an in-app chat model.',
      hasKey: () => this.userConfig.hasCursorApiKey(),
    },
    {
      id: 'gemini',
      label: 'Gemini API key',
      hint: 'Google AI Studio key. Used for Ask AI from the browser.',
      hasKey: () => this.userConfig.hasGeminiApiKey(),
    },
    {
      id: 'claude',
      label: 'Claude API key',
      hint: 'Anthropic key. Browser calls may be blocked by CORS; Gemini is the fallback.',
      hasKey: () => this.userConfig.hasClaudeApiKey(),
    },
  ];

  drafts: Record<AiProviderId, string> = { cursor: '', gemini: '', claude: '' };
  busy = signal<AiProviderId | null>(null);
  error = signal<string | null>(null);
  message = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      await this.userConfig.refresh();
    } catch {
      /* ignore */
    }
  }

  async save(provider: AiProviderId): Promise<void> {
    this.busy.set(provider);
    this.error.set(null);
    this.message.set(null);
    try {
      await this.userConfig.saveAiApiKey(provider, this.drafts[provider]);
      this.drafts[provider] = '';
      this.message.set(`${this.labelOf(provider)} saved.`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not save the key');
    } finally {
      this.busy.set(null);
    }
  }

  async clear(provider: AiProviderId): Promise<void> {
    this.busy.set(provider);
    this.error.set(null);
    this.message.set(null);
    try {
      await this.userConfig.clearAiApiKey(provider);
      this.drafts[provider] = '';
      this.message.set(`${this.labelOf(provider)} cleared.`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not clear the key');
    } finally {
      this.busy.set(null);
    }
  }

  private labelOf(provider: AiProviderId): string {
    return this.rows.find((row) => row.id === provider)?.label ?? provider;
  }
}
