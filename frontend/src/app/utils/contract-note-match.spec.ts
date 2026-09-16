import { parseContractNoteText } from './contract-note-parse.utils';
import { holdingsToOpenLots, matchContractNoteDay } from './contract-note-match.utils';
import { UnrealisedHolding } from '../models/trade.models';

const SAMPLE = `
Unique Client Code 1048496567 Name Ekansh Rastogi
PAN BAAPR5435B
Contract Note no. CN/27/0108788708
Trade Date 16-09-2026
EQUITY
INE02NC01014 FINO PAYMENTS BANK LTD 2500 140.00 0.008 140.01 -350020.00 -2500 142.50 0.008 142.49 356230.00 0 6210.00
INE849A01020 TRENT LTD 1500 2787.17 0.0133 2787.18 -4180773.85 -1500 2750.67 0.0533 2750.61 4125920.00 0 -54853.85
Pay In / Pay Out Obligation (before Brokerage) -19738.50 -19738.50
Taxable Value of Supply (Brokerage) -500.00 -500.00
Exchange Transaction Charges -733.03 -733.03
CGST (9% on Brokerage, Exchange transaction charges, SEBI turnover fees and IPFT charges) 0.00 0.00
SGST (9% on Brokerage, Exchange transaction charges, SEBI turnover fees and IPFT charges) 0.00 0.00
IGST (18% on Brokerage, Exchange transaction charges, SEBI turnover fees and IPFT charges) -226.02 -226.02
Securities Transaction Tax -2829.00 -2829.00
SEBI Turnover Fees -22.63 -22.63
Stamp Duty -340.00 -340.00
IPFT Charges -0.02 -0.02
Net Amount Receivable / Payable By Client -24389.20 -24389.20
Annexure A
`;

describe('contract-note-parse', () => {
  it('parses trade date, equity nets, and day charges', () => {
    const note = parseContractNoteText(SAMPLE);
    expect(note.tradeDate).toBe('2026-09-16');
    expect(note.clientCode).toBe('1048496567');
    expect(note.pan).toBe('BAAPR5435B');
    expect(note.equity.length).toBe(2);
    expect(note.equity[0].netAmount).toBe(6210);
    expect(note.equity[1].netAmount).toBe(-54853.85);
    expect(note.charges.find((c) => c.label === 'STT')?.amount).toBe(2829);
    expect(note.charges.find((c) => c.label === 'SEBI Charges')?.amount).toBe(22.63);
    expect(note.chargesTotal).toBeCloseTo(4650.7, 2);
  });
});

describe('contract-note-match', () => {
  it('builds same-day intraday lots when net flat', () => {
    const note = parseContractNoteText(SAMPLE);
    const matched = matchContractNoteDay(note, []);
    expect(matched.trades.length).toBe(2);
    expect(matched.trades.every((t) => t.buyDate === t.sellDate)).toBeTrue();
    expect(matched.trades.reduce((s, t) => s + t.realisedPnL, 0)).toBeCloseTo(-48643.85, 2);
  });

  it('FIFO-consumes open lots for excess sells', () => {
    const note = parseContractNoteText(`
Unique Client Code 1 Name Test
PAN ABCDE1234F
Trade Date 17-09-2026
INE02NC01014 FINO PAYMENTS BANK LTD 0 0 0 0 0 -500 150.00 0 150.00 75000.00 -500 0
Pay In / Pay Out Obligation (before Brokerage) 0 0
Net Amount Receivable / Payable By Client 0 0
Annexure A
`);
    const holdings: UnrealisedHolding[] = [
      {
        stockName: 'FINO PAYMENTS BANK LTD',
        isin: 'INE02NC01014',
        symbol: 'FINO',
        quantity: 500,
        avgBuyPrice: 140,
        buyValue: 70000,
        closingPrice: 140,
        closingValue: 70000,
        unrealisedPnL: 0,
        unrealisedPnLPct: 0,
        asOfDate: '2026-09-16',
        lots: [
          {
            stockName: 'FINO PAYMENTS BANK LTD',
            isin: 'INE02NC01014',
            quantity: 500,
            buyDate: '2026-09-10',
            buyPrice: 140,
            buyValue: 70000,
            closingDate: '2026-09-16',
            closingPrice: 140,
            closingValue: 70000,
            unrealisedPnL: 0,
            remark: '',
            holdingDays: 6,
          },
        ],
      },
    ];
    const matched = matchContractNoteDay(note, holdingsToOpenLots(holdings));
    expect(matched.trades.length).toBe(1);
    expect(matched.trades[0].buyDate).toBe('2026-09-10');
    expect(matched.trades[0].realisedPnL).toBeCloseTo(5000, 2);
    expect(matched.openLots.length).toBe(0);
  });
});
