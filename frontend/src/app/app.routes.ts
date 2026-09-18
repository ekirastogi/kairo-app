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
        data: { title: 'Stock plans', subtitle: 'Buy/sell lots and charge-aware exit prices' },
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
        path: 'trade-plans/new',
        loadComponent: () =>
          import('./components/trade-plans/trade-plan-form.component').then((m) => m.TradePlanFormComponent),
        data: { title: 'Add trade plan', subtitle: 'Plan a new trade for the selected date' },
      },
      {
        path: 'trade-plans/:id/edit',
        loadComponent: () =>
          import('./components/trade-plans/trade-plan-form.component').then((m) => m.TradePlanFormComponent),
        data: { title: 'Edit trade plan', subtitle: 'Update an existing trade plan' },
      },
      {
        path: 'trade-plans',
        loadComponent: () =>
          import('./components/trade-plans/trade-plans.component').then((m) => m.TradePlansComponent),
        data: { title: 'Trade plans', subtitle: 'Daily trade recommendations and execution tracking' },
      },
      {
        path: 'calendar',
        loadComponent: () =>
          import('./components/trade-calendar/trade-calendar.component').then((m) => m.TradeCalendarComponent),
        data: { title: 'Trade calendar', subtitle: 'Estimated vs realized P&L by day' },
      },
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
      { path: 'signals', redirectTo: '', pathMatch: 'full' },
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
