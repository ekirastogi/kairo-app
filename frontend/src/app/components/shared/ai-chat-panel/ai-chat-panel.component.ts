import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AiChatService } from '../../../services/ai-chat.service';
import { AiProviderId, UserConfigService } from '../../../services/user-config.service';
import { ViewContextService } from '../../../services/view-context.service';

@Component({
  selector: 'app-ai-chat-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './ai-chat-panel.component.html',
  host: { class: 'block h-full min-h-0' },
})
export class AiChatPanelComponent implements OnInit {
  readonly chat = inject(AiChatService);
  readonly viewContext = inject(ViewContextService);
  private keys = inject(UserConfigService);

  draft = signal('');
  contextOpen = signal(false);
  contextDraft = signal('');
  contextError = signal<string | null>(null);
  contextSaved = signal(false);

  readonly providers: { id: AiProviderId; label: string }[] = [
    { id: 'gemini', label: 'Gemini' },
    { id: 'claude', label: 'Claude' },
    { id: 'cursor', label: 'Cursor' },
  ];

  async ngOnInit(): Promise<void> {
    try {
      await this.keys.refresh();
    } catch {
      /* ignore */
    }
    if (!this.viewContext.live().data || Object.keys(this.viewContext.live().data).length === 0) {
      this.viewContext.captureRoute();
    }
  }

  hasKey(provider: AiProviderId): boolean {
    return this.keys.hasAiKey(provider);
  }

  openContext(): void {
    this.contextDraft.set(this.viewContext.displayJson());
    this.contextError.set(null);
    this.contextSaved.set(false);
    this.contextOpen.set(true);
  }

  closeContext(): void {
    this.contextOpen.set(false);
    this.contextError.set(null);
    this.contextSaved.set(false);
  }

  applyContext(): void {
    try {
      this.viewContext.applyEditedJson(this.contextDraft());
      this.contextError.set(null);
      this.contextSaved.set(true);
    } catch {
      this.contextError.set('Context must be valid JSON.');
      this.contextSaved.set(false);
    }
  }

  resetContext(): void {
    this.viewContext.resetEdited();
    this.viewContext.captureRoute();
    this.contextDraft.set(this.viewContext.displayJson());
    this.contextError.set(null);
    this.contextSaved.set(true);
  }

  async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text) return;
    this.draft.set('');
    await this.chat.send(text);
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }
}
