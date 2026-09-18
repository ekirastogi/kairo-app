import { Component, model, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  EXAMPLE_STOCK_SCENARIOS,
  STOCK_FILTER_COLUMNS,
  StockFilterColumn,
  StockFilterRule,
  StockScenario,
  createStockFilterRule,
  defaultOperatorForColumn,
  loadSavedStockScenarios,
  operatorsForColumn,
  persistStockScenarios,
} from '../../../utils/stock-scenario.utils';

@Component({
  selector: 'app-stock-scenario-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './stock-scenario-panel.component.html',
  host: { class: 'contents' },
})
export class StockScenarioPanelComponent {
  open = model(false);
  rules = model<StockFilterRule[]>([]);

  rulesChange = output<StockFilterRule[]>();

  scenarioNameInput = signal('');
  savedScenarios = signal<StockScenario[]>(loadSavedStockScenarios());

  readonly filterColumns = STOCK_FILTER_COLUMNS;
  readonly examples = EXAMPLE_STOCK_SCENARIOS;

  hasActiveScenario(): boolean {
    return this.rules().some((rule) => rule.value.trim() !== '');
  }

  toggle(): void {
    this.open.update((v) => !v);
  }

  operatorsFor(column: StockFilterColumn) {
    return operatorsForColumn(column);
  }

  placeholderFor(column: StockFilterColumn): string {
    if (column === 'stockName') return 'e.g. RELIANCE';
    if (column === 'realisedPnLPct') return 'e.g. 5 for 5%';
    return 'e.g. 0';
  }

  addRule(): void {
    this.patchRules([...this.rules(), createStockFilterRule()]);
  }

  removeRule(id: string): void {
    this.patchRules(this.rules().filter((rule) => rule.id !== id));
  }

  updateRule(
    id: string,
    patch: Partial<Pick<StockFilterRule, 'column' | 'operator' | 'value'>>
  ): void {
    this.patchRules(
      this.rules().map((rule) => {
        if (rule.id !== id) return rule;
        const next = { ...rule, ...patch };
        if (patch.column && patch.column !== rule.column) {
          next.operator = defaultOperatorForColumn(patch.column);
          if (patch.column === 'stockName') next.value = '';
        }
        return next;
      })
    );
  }

  clearAll(): void {
    this.patchRules([]);
    this.scenarioNameInput.set('');
  }

  loadExample(index: number): void {
    const example = this.examples[index];
    if (!example) return;
    this.patchRules(example.rules.map((rule) => createStockFilterRule(rule)));
    this.scenarioNameInput.set(example.name);
    this.open.set(true);
  }

  saveScenario(): void {
    const name = this.scenarioNameInput().trim();
    if (!name || !this.rules().length) return;
    const scenario: StockScenario = {
      id: createStockFilterRule().id,
      name,
      rules: this.rules().map((rule) => ({ ...rule })),
      createdAt: Date.now(),
    };
    this.savedScenarios.update((scenarios) => {
      const withoutDuplicate = scenarios.filter(
        (item) => item.name.toLowerCase() !== name.toLowerCase()
      );
      const next = [scenario, ...withoutDuplicate].slice(0, 10);
      persistStockScenarios(next);
      return next;
    });
  }

  loadSaved(id: string): void {
    const scenario = this.savedScenarios().find((item) => item.id === id);
    if (!scenario) return;
    this.patchRules(scenario.rules.map((rule) => createStockFilterRule(rule)));
    this.scenarioNameInput.set(scenario.name);
    this.open.set(true);
  }

  deleteSaved(id: string): void {
    this.savedScenarios.update((scenarios) => {
      const next = scenarios.filter((item) => item.id !== id);
      persistStockScenarios(next);
      return next;
    });
  }

  private patchRules(next: StockFilterRule[]): void {
    this.rules.set(next);
    this.rulesChange.emit(next);
  }
}
