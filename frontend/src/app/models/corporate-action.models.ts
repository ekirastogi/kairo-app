export type CorporateActionType = 'merge' | 'split' | 'rename';

export interface CorporateAction {
  id: string;
  userId?: string;
  actionType: CorporateActionType;
  fromSymbol: string;
  fromName: string;
  fromIsin: string;
  toSymbol: string;
  toName: string;
  toIsin: string;
  /** Old shares in the exchange ratio (e.g. 100 Mindtree). */
  ratioFrom: number;
  /** New shares in the exchange ratio (e.g. 73 LTIM). */
  ratioTo: number;
  effectiveDate: string;
  recordDate?: string | null;
  notes: string;
  sourceUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface CorporateActionInput {
  actionType: CorporateActionType;
  fromSymbol: string;
  fromName?: string;
  fromIsin?: string;
  toSymbol: string;
  toName?: string;
  toIsin?: string;
  ratioFrom?: number;
  ratioTo?: number;
  effectiveDate: string;
  recordDate?: string;
  notes?: string;
  sourceUrl?: string;
}

export const CORPORATE_ACTION_TYPE_LABELS: Record<CorporateActionType, string> = {
  merge: 'Merger / amalgamation',
  split: 'Stock split',
  rename: 'Rename / rebrand',
};

/** Built-in seeds from known NSE amalgamations (Mindtree, TV18). */
export const SEEDED_CORPORATE_ACTIONS: Omit<
  CorporateAction,
  'id' | 'userId' | 'createdAt' | 'updatedAt'
>[] = [
  {
    actionType: 'merge',
    fromSymbol: 'MINDTREE',
    fromName: 'Mindtree Ltd',
    // Surviving entity is former LTI (LTM LIMITED) ISIN.
    fromIsin: 'INE018I01017',
    toSymbol: 'LTIM',
    toName: 'LTIMindtree Ltd',
    toIsin: 'INE214T01019',
    ratioFrom: 100,
    ratioTo: 73,
    effectiveDate: '2022-11-14',
    recordDate: '2022-11-24',
    notes:
      'Mindtree amalgamated into LTI (now LTIMindtree). 73 LTIM shares for every 100 Mindtree shares.',
    sourceUrl: 'https://www.screener.in/company/MINDTREE/consolidated/',
  },
  {
    actionType: 'merge',
    fromSymbol: 'TV18BRDCST',
    fromName: 'TV18 Broadcast Ltd',
    fromIsin: 'INE886H01027',
    toSymbol: 'NETWORK18',
    toName: 'Network18 Media & Investments Ltd',
    toIsin: 'INE870H01013',
    ratioFrom: 172,
    ratioTo: 100,
    effectiveDate: '2024-10-03',
    recordDate: '2024-10-16',
    notes:
      'TV18 Broadcast amalgamated into Network18. 100 NETWORK18 shares for every 172 TV18 shares.',
    sourceUrl: 'https://www.screener.in/company/TV18BRDCST/consolidated/',
  },
];
