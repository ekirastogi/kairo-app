import { Component, inject, signal, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd, ActivatedRoute } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { AppErrorHandler } from '../services/app-error-handler.service';
import { ReportStateService } from '../services/report-state.service';
import { PageShellService } from '../services/page-shell.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { FilterUrlService } from '../services/filter-url.service';
import { BrandLogoComponent } from '../components/shared/brand-logo/brand-logo.component';
import { BRAND } from '../constants/brand';

interface NavItem {
  label: string;
  route: string;
  exact?: boolean;
  icon: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface MobileNavItem {
  label: string;
  route: string;
  exact?: boolean;
  icon: string;
}

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, BrandLogoComponent],
  templateUrl: './admin-layout.component.html',
})
export class AdminLayoutComponent implements OnInit, OnDestroy {
  readonly state = inject(ReportStateService);
  /** Surfaces uncaught errors as a dismissible banner instead of console-only. */
  readonly errors = inject(AppErrorHandler);
  readonly pageShell = inject(PageShellService);
  readonly auth = inject(AuthService);
  readonly brand = BRAND;
  private notifications = inject(NotificationService);
  private filterUrl = inject(FilterUrlService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private navSub?: Subscription;

  sidebarOpen = signal(true);
  isMobile = signal(typeof window !== 'undefined' && window.innerWidth < 1024);

  readonly navSections: NavSection[] = [
    {
      title: 'Portfolio',
      items: [
        {
          label: 'Performance',
          route: '/analytics',
          icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
        },
        {
          label: 'Charges',
          route: '/charges',
          icon: 'M9 14l2 2 4-4m5-2a9 9 0 11-18 0 9 9 0 0118 0z',
        },
      ],
    },
    {
      title: 'Planning',
      items: [
        {
          label: 'Trade plans',
          route: '/trade-plans',
          icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
        },
        {
          label: 'Plans',
          route: '/utils',
          icon: 'M9 7h6m-6 4h6m-7 4h8M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z',
        },
        {
          label: 'Calendar',
          route: '/calendar',
          icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
        },
      ],
    },
    {
      title: 'Market',
      items: [
        {
          label: 'Stock registry',
          route: '/registry',
          icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
        },
        {
          label: 'Signals',
          route: '/',
          exact: true,
          icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
        },
        {
          label: 'Market data',
          route: '/stocks',
          icon: 'M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z',
        },
      ],
    },
    {
      title: 'Settings',
      items: [
        {
          label: 'Settings',
          route: '/settings',
          icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
        },
      ],
    },
  ];

  readonly mobileNavItems: MobileNavItem[] = [
    {
      label: 'Home',
      route: '/analytics',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      label: 'Plans',
      route: '/trade-plans',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      label: 'Signals',
      route: '/',
      exact: true,
      icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    },
    {
      label: 'Settings',
      route: '/settings',
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    },
  ];

  async ngOnInit(): Promise<void> {
    this.applySafeAreaInsets();
    if (typeof window !== 'undefined') {
      window.addEventListener('orientationchange', this.onSafeAreaChange);
      window.visualViewport?.addEventListener('resize', this.onSafeAreaChange);
      requestAnimationFrame(() => this.applySafeAreaInsets());
      setTimeout(() => this.applySafeAreaInsets(), 100);
    }
    this.syncPageHeader();
    this.navSub = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.syncPageHeader());

    if (this.auth.hasAccess) {
      this.notifications.requestPermission();
    }
    if (this.isMobile()) {
      this.sidebarOpen.set(false);
    }

    await this.auth.whenReady();
    this.filterUrl.start();
    // No background report refresh — filters and data stay put until the user reloads.
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener('orientationchange', this.onSafeAreaChange);
      window.visualViewport?.removeEventListener('resize', this.onSafeAreaChange);
    }
  }

  private onSafeAreaChange = (): void => {
    this.applySafeAreaInsets();
  };

  private syncPageHeader(): void {
    let child = this.route.firstChild;
    while (child?.firstChild) {
      child = child.firstChild;
    }
    const data = child?.snapshot.data ?? {};
    this.pageShell.setRouteHeader(data['title'] ?? '', data['subtitle'] ?? null);
  }

  @HostListener('window:resize')
  onResize(): void {
    const mobile = window.innerWidth < 1024;
    const wasMobile = this.isMobile();
    this.isMobile.set(mobile);
    if (mobile && !wasMobile) {
      this.sidebarOpen.set(false);
    }
    this.applySafeAreaInsets();
  }

  private applySafeAreaInsets(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe);
    const top = parseFloat(computed.paddingTop) || 0;
    const bottom = parseFloat(computed.paddingBottom) || 0;
    const left = parseFloat(computed.paddingLeft) || 0;
    const right = parseFloat(computed.paddingRight) || 0;
    probe.remove();

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isMobile = window.innerWidth < 1024;
    const topFallback = isMobile && isIOS ? 59 : isMobile ? 20 : 0;
    const effectiveTop = Math.max(top, topFallback);

    root.style.setProperty('--safe-area-top', `${top}px`);
    root.style.setProperty('--safe-area-bottom', `${bottom}px`);
    root.style.setProperty('--safe-area-left', `${left}px`);
    root.style.setProperty('--safe-area-right', `${right}px`);
    root.style.setProperty('--safe-area-top-effective', `${effectiveTop}px`);
    root.style.setProperty(
      '--app-shell-top-offset',
      `calc(${effectiveTop}px + var(--app-header-body-height))`
    );
    root.style.setProperty('--app-top-offset', `calc(${effectiveTop}px + var(--app-header-body-height))`);
    root.classList.toggle('ios-mobile', isMobile && isIOS);
  }

  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  onNavigate(): void {
    if (this.isMobile()) {
      this.closeSidebar();
    }
  }

  async logout(): Promise<void> {
    // Drop cached trade data before signing out: the report history lives under a fixed,
    // uid-independent storage key, so leaving it behind exposes one account's P&L to the
    // next person to sign in on this browser.
    this.state.stopPeriodicRefresh();
    this.state.clear();
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  userInitial(email: string | null | undefined): string {
    return (email?.charAt(0) ?? 'U').toUpperCase();
  }
}
