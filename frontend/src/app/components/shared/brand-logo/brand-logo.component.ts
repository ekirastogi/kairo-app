import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BRAND } from '../../../constants/brand';

@Component({
  selector: 'app-brand-logo',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <a
      routerLink="/"
      class="flex items-center outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-kairo-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      [class]="compact ? 'gap-2' : 'gap-3'"
      [attr.aria-label]="BRAND.name + ' home'"
    >
      <div
        class="flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-kairo-400 to-kairo-600 shadow-lg shadow-kairo-500/20"
        [class]="compact ? 'h-8 w-8' : 'h-10 w-10'"
      >
        <svg viewBox="0 0 24 24" class="text-white" [class]="compact ? 'h-4 w-4' : 'h-5 w-5'" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 18V6l6 6 6-6v12" />
        </svg>
      </div>
      @if (showText) {
        <div class="min-w-0">
          <div
            class="font-display font-bold tracking-tight"
            [class]="compact ? 'text-base' : 'text-lg'"
            [class.text-white]="variant === 'light'"
            [class.text-slate-900]="variant === 'dark'"
          >{{ BRAND.name }}</div>
          @if (showTagline && !compact) {
            <div
              class="truncate text-[11px] font-medium uppercase tracking-wider"
              [class.text-slate-400]="variant === 'light'"
              [class.text-slate-500]="variant === 'dark'"
            >{{ BRAND.tagline }}</div>
          }
        </div>
      }
    </a>
  `,
})
export class BrandLogoComponent {
  readonly BRAND = BRAND;
  @Input() showText = true;
  @Input() showTagline = false;
  @Input() compact = false;
  @Input() variant: 'light' | 'dark' = 'light';
}
