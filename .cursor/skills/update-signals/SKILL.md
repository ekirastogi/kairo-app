---
name: update-signals
description: Daily refresh of the Kairo TradeBook watchlist — persist CMP, news, brokerage targets, AI analysis (last 10), and a positive/negative/neutral call into Supabase so TradeBook shows it on any device. Use when the user says update signals, refresh signals, daily signals, broker targets, AI analysis, or run the update-signals skill.
---

# Update Signals

Run a **daily** research pass over every row in `public.signal_watch`, then **write it to the database**. TradeBook (`/trade-book`) reads that table (and CMP from `registry_stocks`). The user should see news, brokers, the call, analysis, and CMP **from any device** after a page load. Do not leave results only in chat.

Repo: `kairo-app`. Do not skip stocks. Do not invent URLs or target prices.

The watchlist UI is **TradeBook**, not the blank Signals page. TradeBook tints a row **green** when the call is positive and CMP is within ~1% of the nearest support, and **red** when the call is negative and CMP is within ~1% of the nearest resistance. The strip shows up to two user prices below CMP and two above.

If the calendar is a weekend or market holiday, use the **last completed NSE session** (typically Friday) as “today”.

## Quick start

1. List the watchlist (includes stored CMP when present):
   `python3 .cursor/skills/update-signals/scripts/list_signals.py`
2. For **Nifty 50** (and Bank Nifty if useful) search the last session: up/down vs previous close, one-line reason.
3. For **each** symbol in the dump, complete the per-stock loop below.
4. Write `/tmp/kairo-signal-research.json` then:
   `python3 .cursor/skills/update-signals/scripts/write_research.py /tmp/kairo-signal-research.json`
5. Confirm the script printed `updatedRows` matching the watchlist. That **is** the DB write. Tell the user a table: symbol, overall call, CMP vs two-below / two-above, news count, broker count, analysis title.

If `list_signals.py` fails, apply `supabase/migrations/029_signal_watch_research.sql` the same way as other Kairo SQL (Postgres user `postgres`, password from `backend/.env`, host `db.vufjhwxlyhxunqhfeqtr.supabase.co`) then retry.

## Per-stock loop

Use WebSearch / WebFetch. Prefer Moneycontrol, Economic Times, Business Standard, NSE bhavcopy, Screener.in, broker PDFs. Cap **10** news items, newest first.

1. **CMP / financials**  
   Record last **close** for the session you are using. Prefer NSE bhavcopy / exchange history, then Screener. Put `cmp` on every JSON stock (required when a number exists). Optional: `pe`, `marketCap`, `salesGrowthTtm`, `profitGrowthTtm`. Do not scrape behind logins. Do not tell the user to click Refresh all to “save” this — `write_research.py` writes CMP into `registry_stocks` for every user who watches the symbol.

2. **News (10 latest)**  
   Search `{name} {symbol} stock news`. Keep distinct headlines from the last ~14 days when possible. Each item: `title`, `source`, `url`, `publishedAt` (ISO if known, else `YYYY-MM-DD`), `summary` (one sentence). Drop paywalled junk and duplicate wires.

3. **Broker targets**  
   Search `{symbol} OR {name} share target price Motilal ICICI HDFC Kotak Axis Macquarie`. Keep `{ broker, price }` only when a numeric target is explicit. Merge with existing targets (same broker → replace price; unknown broker → append).

4. **Nifty + sector**  
   One line each: index/sector last session vs prior close and whether the stock is leading or lagging.

5. **Overall call** — `positive` | `negative` | `neutral`  
   Weigh **in this order**:
   - **User prices vs CMP**: use the **two** nearest levels below CMP and **two** above. Nearest below holding (especially CMP within ~1% of that support) = buy zone (leans positive). CMP already through the highest user price, or within ~1% of the nearest resistance with no hold, = extended (leans negative). Mid-ladder with both sides close = mixed.
   - **Nifty**: risk-on (up) supports a positive call only if the stock is not breaking down vs the ladder; risk-off (down) supports negative unless the stock is holding the below-CMP level.
   - **Sector**: same as Nifty; sector down + CMP losing the below level → negative.
   - **News / brokers**: upgrades, beats, raised targets → positive; downgrades, misses, fraud/legal → negative. If news and price-structure disagree, prefer **neutral** and say why.
   Write `signalReason` in 1–3 sentences naming prices, Nifty, and sector.

6. **AI analysis report** (prepend; store last 10)  
   Write a detailed `analysis` markdown body (not a tweet). Required headings:
   - **Setup** — CMP vs user P-levels, naming up to two supports below and two resistances above.
   - **Index & sector** — Nifty (and sector) last session and relative strength.
   - **Financials** — QoQ/YoY sales, profit, OPM when known.
   - **News & brokers** — what the headlines and targets imply.
   - **Call** — positive / negative / neutral and what would change it.
   Also set `analysisTitle` like `15 Nov · Positive · holding support`. Same title on a rerun **replaces** the latest report instead of duplicating it.

## JSON file shape

```json
{
  "niftyNote": "Nifty -0.6% on FII selling",
  "stocks": [
    {
      "symbol": "AEGISLOGISTICS",
      "cmp": 1222.65,
      "brokerTargets": [{ "broker": "Motilal", "price": 850 }],
      "news": [
        {
          "title": "Aegis gas volumes rise",
          "source": "Economic Times",
          "url": "https://...",
          "publishedAt": "2026-11-15",
          "summary": "Management guided higher LPG throughput."
        }
      ],
      "overallSignal": "positive",
      "signalReason": "CMP holds 1196 while Nifty is only mildly red; sector in line.",
      "niftyNote": "Nifty -0.6%",
      "sectorNote": "Logistics -0.2%, stock outperforming",
      "analysisTitle": "15 Nov · Positive · holding support",
      "analysis": "## Setup\nCMP 1223 holds 1196 / 1080 below, 1245 / 1310 overhead.\n\n## Index & sector\nNifty -0.6%; logistics flat.\n\n## Financials\n...\n\n## News & brokers\n...\n\n## Call\nPositive while nearest support holds."
    }
  ]
}
```

`write_research.py` updates **all** `signal_watch` rows for that `symbol` (every user): news (replaced, max 10), overall call, notes, brokers (kept if omitted), AI reports. It also upserts **`registry_stocks.current_price`** (and optional PE / cap / TTM growth) so TradeBook CMP is in the DB.

## After writing

Tell the user the DB is updated. Open **TradeBook** on any signed-in device (hard-refresh if the tab was already open). News, call, analysis, and CMP come from Supabase — no local Refresh all is required for this pass. **Refresh all** only re-scrapes Screener from the browser if they want a fuller fundamentals dump.

## Do not

- Place trades or change user price levels.
- Fabricate broker houses or headlines.
- Commit `backend/.env` or print the DB password.
- Finish without running `write_research.py`.
