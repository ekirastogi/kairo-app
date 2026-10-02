import { Component, ElementRef, OnInit, ViewChild, effect, inject, signal } from '@angular/core';
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
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }
      .ai-chat {
        display: flex;
        min-height: 0;
        height: 100%;
        flex-direction: column;
        background: var(--c-bg);
        color: var(--c-text);
      }
      .ai-chat.is-dark {
        --c-bg: #0b141a;
        --c-header: #202c33;
        --c-muted: #8696a0;
        --c-border: rgba(255, 255, 255, 0.08);
        --c-user: #005c4b;
        --c-user-text: #e9edef;
        --c-bot: #202c33;
        --c-bot-text: #e9edef;
        --c-input: #2a3942;
        --c-composer: #202c33;
        --c-hover: rgba(255, 255, 255, 0.08);
      }
      .ai-chat.is-light {
        --c-bg: #efeae2;
        --c-header: #f0f2f5;
        --c-muted: #667781;
        --c-border: rgba(17, 27, 33, 0.1);
        --c-user: #d9fdd3;
        --c-user-text: #111b21;
        --c-bot: #ffffff;
        --c-bot-text: #111b21;
        --c-input: #ffffff;
        --c-composer: #f0f2f5;
        --c-hover: rgba(17, 27, 33, 0.06);
      }
    `,
  ],
})
export class AiChatPanelComponent implements OnInit {
  readonly chat = inject(AiChatService);
  readonly viewContext = inject(ViewContextService);
  private keys = inject(UserConfigService);

  @ViewChild('thread') thread?: ElementRef<HTMLDivElement>;

  draft = signal('');
  contextOpen = signal(false);
  contextDraft = signal('');
  notesDraft = signal('');
  contextError = signal<string | null>(null);

  readonly providers: { id: AiProviderId; label: string }[] = [
    { id: 'gemini', label: 'Gemini' },
    { id: 'claude', label: 'Claude' },
    { id: 'cursor', label: 'Cursor' },
  ];

  constructor() {
    effect(() => {
      this.chat.messages();
      this.chat.sending();
      queueMicrotask(() => this.scrollThread());
    });
  }

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

  onProviderChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as AiProviderId;
    if (value === 'gemini' || value === 'claude' || value === 'cursor') {
      this.chat.setProvider(value);
    }
  }

  toggleContext(): void {
    if (this.contextOpen()) {
      this.applyContext();
      if (this.contextError()) return;
      this.contextOpen.set(false);
      return;
    }
    this.notesDraft.set(this.viewContext.extraNotes());
    this.contextDraft.set(this.viewContext.displayJson());
    this.contextError.set(null);
    this.contextOpen.set(true);
  }

  applyContext(): void {
    this.viewContext.extraNotes.set(this.notesDraft());
    try {
      this.viewContext.applyEditedJson(this.contextDraft());
      this.contextError.set(null);
    } catch {
      this.contextError.set('Page context must be valid JSON.');
    }
  }

  onNotesChange(value: string): void {
    this.notesDraft.set(value);
    this.viewContext.extraNotes.set(value);
  }

  resetContext(): void {
    this.viewContext.resetEdited();
    this.notesDraft.set('');
    this.contextDraft.set(this.viewContext.displayJson());
    this.contextError.set(null);
  }

  async send(): Promise<void> {
    if (this.contextOpen()) this.applyContext();
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

  formatTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private scrollThread(): void {
    const el = this.thread?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
