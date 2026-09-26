import { Routes } from '@angular/router';
import { SignalsComponent } from './components/signals/signals.component';
import { LoginComponent } from './components/login/login.component';
import { AdminLayoutComponent } from './layout/admin-layout.component';
import { authGuard, loginGuard } from './guards/auth.guard';
import { redirectToAnalytics } from './guards/analytics-redirect.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent, canActivate: [loginGuard] },
  {
    path: '',
    component: AdminLayoutComponent,
    canActivate: [authGuard],
    children: [
      {
        path: '',
        redirectTo: 'analytics',
        pathMatch: 'full',
      },
      {
        path: 'signals',
        component: SignalsComponent,
        data: { title: 'Signals', subtitle: 'Trade recommendations from your engine' },
      },
      {
        path: 'analytics/custom-lists/new',
        loadComponent: () =>
          import('./components/dashboard/custom-stock-list-editor.component').then(
            (m) => m.CustomStockListEditorComponent
          ),
        data: { title: 'New custom list', subtitle: 'Pick stocks for a focused Performance view' },
      },
      {
        path: 'analytics/custom-lists/:id',
        loadComponent: () =>
          import('./components/dashboard/custom-stock-list-editor.component').then(
            (m) => m.CustomStockListEditorComponent
          ),
        data: { title: 'Edit custom list', subtitle: 'Update the stocks in this Performance view' },
      },
      {
        path: 'dashboard/custom-lists/new',
        redirectTo: 'analytics/custom-lists/new',
        pathMatch: 'full',
      },
      {
        path: 'dashboard/custom-lists/:id',
        redirectTo: 'analytics/custom-lists/:id',
        pathMatch: 'full',
      },
      {
        path: 'dashboard',
        canActivate: [redirectToAnalytics('stocks')],
        loadComponent: () =>
          import('./components/analytics/analytics.component').then((m) => m.AnalyticsComponent),
      },
      {
        path: 'upload',
        redirectTo: 'settings',
        pathMatch: 'full',
      },
      {
        path: 'analytics',
        loadComponent: () =>
          import('./components/analytics/analytics.component').then((m) => m.AnalyticsComponent),
        data: { title: 'Performance', subtitle: 'P&L overview, stocks, tiers, and charts' },
      },
      {
        path: 'utils',
        loadComponent: () =>
          import('./components/utils/utils.component').then((m) => m.UtilsComponent),
        data: { title: 'Utility', subtitle: 'Buy/sell lots and charge-aware exit prices' },
      },
      {
        path: 'charges',
        loadComponent: () =>
          import('./components/charges/charges.component').then((m) => m.ChargesComponent),
        data: { title: 'Charges', subtitle: 'Trading fees from your report' },
      },
      {
        path: 'registry',
        loadComponent: () =>
          import('./components/stock-registry/stock-registry.component').then((m) => m.StockRegistryComponent),
        data: { title: 'Stock registry', subtitle: 'Your tracked stocks with levels and indicators' },
      },
      {
        path: 'corporate-actions',
        loadComponent: () =>
          import('./components/corporate-actions/corporate-actions.component').then(
            (m) => m.CorporateActionsComponent
          ),
        data: {
          title: 'Corporate actions',
          subtitle: 'Mergers, splits, and renames applied before trades are saved',
        },
      },
      {
        path: 'trade-plans',
        loadComponent: () =>
          import('./components/tracking/tracking.component').then((m) => m.TrackingComponent),
        data: {
          title: 'Trade plans',
          subtitle: 'Watch a stock, then add size and exits for charges and net P&L',
        },
      },
      { path: 'tracking', redirectTo: 'trade-plans', pathMatch: 'full' },
      {
        path: 'momentum',
        loadComponent: () =>
          import('./components/momentum-stocks/momentum-stocks.component').then(
            (m) => m.MomentumStocksComponent
          ),
        data: {
          title: 'Momentum stocks',
          subtitle: 'Post-results runners with targets and open trade plans',
        },
      },
      {
        path: 'watchlists',
        canActivate: [redirectToAnalytics('tiers')],
        loadComponent: () =>
          import('./components/analytics/analytics.component').then((m) => m.AnalyticsComponent),
      },
      {
        path: 'stocks',
        loadComponent: () =>
          import('./components/stocks/stocks.component').then((m) => m.StocksComponent),
        data: { title: 'Market data', subtitle: 'Stocks hydrated by the local worker' },
      },
      {
        path: 'stock/:symbol',
        loadComponent: () =>
          import('./components/stock-detail/stock-detail.component').then((m) => m.StockDetailComponent),
        data: { title: 'Stock', subtitle: '' },
      },
      { path: 'heatmap', redirectTo: 'analytics', pathMatch: 'full' },
      {
        path: 'settings',
        loadComponent: () =>
          import('./components/settings/settings.component').then((m) => m.SettingsComponent),
        data: { title: 'Settings', subtitle: 'Upload P&L, backfill, and data management' },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
