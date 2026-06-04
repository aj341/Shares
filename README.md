# Shares — Portfolio Intelligence

Institutional-grade Next.js 15 dashboard for a personal Nasdaq portfolio:
scoring engine, executive sentiment, disagreement scorecard and a
cash-aware redistribution planner.

## Stack

- Next.js 15 (App Router) · TypeScript · Tailwind CSS
- shadcn/ui-style primitives (hand-authored, no CLI needed)
- Recharts (allocation visuals) · Lucide icons · next-themes (dark mode)
- Server-side route handlers in `src/app/api/**/route.ts`

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000  (runs on mock data by default)
```

No API key is required to run — the app ships with a full mock data layer.

## Data sources

Set in `.env` (see `.env.example`):

| Var               | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `DATA_SOURCE`     | `mock` (default), `finnhub`, or `mboum`              |
| `FINNHUB_API_KEY` | Required when `DATA_SOURCE=finnhub` (quotes/day change) |
| `MBOUM_API_KEY`   | History + fundamentals (performance chart, period P&L)  |
| `DATABASE_URL`    | PostgreSQL — persists the ledger (see Persistence below) |

To go live: get a free key at <https://finnhub.io/dashboard>, then

```bash
DATA_SOURCE=finnhub
FINNHUB_API_KEY=your_key_here
```

If a live call fails, each field falls back to mock so the UI never breaks.

## Persistence

The portfolio is derived from a transaction ledger behind a swappable
`PortfolioRepository` (`src/lib/portfolio-store.ts`):

- **`DATABASE_URL` set → PostgreSQL** (`src/lib/db.ts`). Durable and
  multi-instance safe. Tables (`portfolio_meta`, `portfolio_transactions`,
  `portfolio_archived`) are created automatically on first use, and the opening
  positions + cash are seeded once.
- **`DATABASE_URL` unset → JSON file** at `data/portfolio-state.json`. Fine for
  local dev; not safe across instances or on an ephemeral filesystem.

Migrate an existing local ledger into Postgres:

```bash
DATABASE_URL=postgres://... npm run migrate:db
```

### Deploy on Railway

1. Create the service from this repo; set `FINNHUB_API_KEY`, `MBOUM_API_KEY`,
   `DATA_SOURCE=finnhub`.
2. Add the **PostgreSQL** plugin — Railway injects `DATABASE_URL` automatically.
3. Build `npm run build`, start `npm run start`. The schema self-initialises and
   seeds on first request; no manual migration needed for a fresh DB.

## API routes

| Route                  | Returns                                           |
| ---------------------- | ------------------------------------------------- |
| `GET /api/portfolio`     | Fully-scored `Holding[]` + book totals          |
| `GET /api/scores`        | Per-ticker score + signal + breakdown           |
| `GET /api/announcements` | Announcements, verdicts and disagreement rows   |
| `GET /api/redistribution`| Trade recommendations, before/after, summary    |
| `GET /api/dashboard`     | Aggregate of all of the above (used by the UI)  |

## Project layout

```
src/
  app/
    layout.tsx · page.tsx · globals.css
    api/{portfolio,scores,announcements,redistribution,dashboard}/route.ts
  components/
    dashboard/  (kpi-cards, holdings-table, stock-detail-sheet, metric-grid,
                 announcements-timeline, verdict-panel, executive-sentiment,
                 disagreement-scorecard, redistribution-table, allocation-chart,
                 dashboard-shell)
    ui/         (card, button, badge, sheet, table, tabs, skeleton, …)
  lib/
    types.ts        — all data contracts (single source of truth)
    constants.ts    — positions, cash, portfolio + scoring rules
    finnhub.ts      — primary provider connector
    mboum.ts        — secondary provider (stub, contract-compatible)
    scoring.ts      — 20-metric weighted engine + override rules
    redistribution.ts — sell/trim/buy + cash allocation
    announcements.ts  — verdicts + disagreement scorecard
    portfolio.ts    — assembles the scored book
    dashboard.ts    — aggregates for the API
    mock-data.ts    — fallback data
```

## Engine rules

- **Scoring:** 20 metrics across 6 categories, weighted
  Trend/Momentum/Valuation/Fundamental 20 each, Risk/Sentiment 10 each.
  Override rules for overbought-with-gains, oversold, weak-fundamentals and
  the 30% position cap. Bands → STRONG_BUY/BUY/HOLD/TRIM/SELL.
- **Redistribution:** full-sell on broken thesis, trim on weak score or
  overbought+overweight, buy strong scores below the 30% cap. ARM-sale cash is
  the first funding source; a 5% cash buffer is retained; whole shares only.

## Deploying to Railway

`npm run build` produces a standard Next.js server build. Set the env vars
above in the Railway service and use `npm run start` as the start command.
