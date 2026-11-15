---
name: update-signals
description: Daily refresh of Kairo Signals watchlist — Screener CMP/financials, latest news, brokerage targets, AI analysis reports (keep last 10), and a positive/negative/neutral overall call using Nifty, sector, and user price levels. Use when the user says update signals, refresh signals, daily signals, broker targets, AI analysis, or run the update-signals skill.
---

# Update Signals

Run this as a **daily** research pass over every row in `public.signal_watch`. Write results into that table so TradeBook shows news, broker targets, and the overall call without a code change.

Repo: `kairo-app`. Do not skip stocks. Do not invent URLs or target prices.

## Quick start

1. List the watchlist:
   `python3 .cursor/skills/update-signals/scripts/list_signals.py`
2. For **Nifty 50** (and Bank Nifty if useful) search today's session: up/down vs previous close, one-line reason.
3. For **each** symbol in the dump, complete the per-stock loop below.
4. Write ` /tmp/kairo-signal-research.json ` then:
   `python3 .cursor/skills/update-signals/scripts/write_research.py /tmp/kairo-signal-research.json`
5. Tell the user a table: symbol, overall call, CMP vs levels, news count, broker count, analysis title.

If `list_signals.py` fails, apply `supabase/migrations/029_signal_watch_research.sql` the same way as other Kairo SQL (Postgres user `postgres`, password from `backend/.env`, host `db.vufjhwxlyhxunqhfeqtr.supabase.co`) then retry.

## Per-stock loop

Use WebSearch / WebFetch. Prefer Moneycontrol, Economic Times, Business Standard, NSE, Screener.in, broker PDFs. Cap **10** news items, newest first.

1. **CMP / financials (Screener)**  
   Open `https://www.screener.in/company/{SYMBOL}/` (try NSE ticker; if 404, search the company name). Record last price, sector if shown, latest quarterly sales/PAT/OPM QoQ & YoY. Tell the user to click **Refresh all** on Signals after you finish so registry CMP/financials persist through the app fetch. Do not scrape behind logins.

2. **News (10 latest)**  
   Search `{name} {symbol} stock news`. Keep distinct headlines from the last ~14 days when possible. Each item: `title`, `source`, `url`, `publishedAt` (ISO if known, else `YYYY-MM-DD`), `summary` (one sentence). Drop paywalled junk and duplicate wires.

3. **Broker targets**  
   Search `{symbol} OR {name} share target price Motilal ICICI HDFC Kotak Axis Macquarie`. Keep `{ broker, price }` only when a numeric target is explicit. Merge with existing targets (same broker → replace price; unknown broker → append).

4. **Nifty + sector**  
   One line each: index/sector today vs prior close and whether the stock is leading or lagging.

5. **Overall call** — `positive` | `negative` | `neutral`  
   Weigh **in this order**:
   - **User prices vs CMP**: nearest level below CMP = buy zone (leans positive); CMP already through the highest user price = extended (leans negative); CMP sitting mid-ladder with both sides close = mixed.
   - **Nifty**: risk-on (up) supports a positive call only if the stock is not breaking down vs the ladder; risk-off (down) supports negative unless the stock is holding the below-CMP level.
   - **Sector**: same as Nifty; sector down + CMP losing the below level → negative.
   - **News / brokers**: upgrades, beats, raised targets → positive; downgrades, misses, fraud/legal → negative. If news and price-structure disagree, prefer **neutral** and say why.
   Write `signalReason` in 1–3 sentences naming prices, Nifty, and sector.

6. **AI analysis report** (prepend; store last 10)  
   Write a detailed `analysis` markdown body (not a tweet). Required headings:
   - **Setup** — CMP vs user P-levels (below/above).
   - **Index & sector** — Nifty (and sector) today and relative strength.
   - **Financials** — Screener QoQ/YoY sales, profit, OPM; anything notable.
   - **News & brokers** — what the 10 headlines and targets imply.
   - **Call** — positive / negative / neutral and what would change it.
   Also set `analysisTitle` like `14 Nov · Positive · holding P2`. This is stored as a new report; older reports stay until 10 exist, then the oldest drops.

## JSON file shape

```json
{
  "niftyNote": "Nifty -0.6% on FII selling",
  "stocks": [
    {
      "symbol": "AEGISLOGISTICS",
      "brokerTargets": [{ "broker": "Motilal", "price": 850 }],
      "news": [
        {
          "title": "Aegis gas volumes rise",
          "source": "Economic Times",
          "url": "https://...",
          "publishedAt": "2026-11-14",
          "summary": "Management guided higher LPG throughput."
        }
      ],
      "overallSignal": "positive",
      "signalReason": "CMP holds P2 1196 while Nifty is only mildly red; sector in line.",
      "niftyNote": "Nifty -0.6%",
      "sectorNote": "Logistics -0.2%, stock outperforming",
      "analysisTitle": "14 Nov · Positive · holding P2",
      "analysis": "## Setup\nCMP 1224 holds P2 1196, P3 1245 overhead.\n\n## Index & sector\nNifty -0.6%; logistics flat.\n\n## Financials\n...\n\n## News & brokers\n...\n\n## Call\nPositive while P2 holds."
    }
  ]
}
```

`write_research.py` updates **all** `signal_watch` rows for that `symbol` (every user). It keeps existing broker targets when the JSON omits `brokerTargets`. News is replaced (max 10). A new `analysis` is **prepended**; at most 10 reports are kept.

## After writing

Remind the user: open Signals → **Refresh all** to pull Screener CMP/financials into the registry. Hard-refresh the page to see news and the call.

## Do not

- Place trades or change user price levels.
- Fabricate broker houses or headlines.
- Commit `backend/.env` or print the DB password.
