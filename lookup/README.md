# Client Lookup (Smart 1 Marketing)

Prebuilt static app, seven sections via the top buttons, plus a global Refresh.
Two data files power everything: build/data/products.json (object_135) and
build/data/websites.json (object_153).

## Sections
1. Client Lookup — creative IO folders by year (5-across), placeholders for
   PDF/Drive/Dropbox/file. Excludes SEM, Website SEO/Listings, Email Blast.
2. Salesperson Lookup — on-demand (pick a salesperson); year-grouped grid /
   table toggle; churn CSV; Overview + IO Detail CSV.
3. Partner Lookup — same, on-demand, by partner.
4. Live Products — By-IO view (status = Live) with budget totals, plus a
   "Search by product" mode listing every client running a chosen product.
5. Dashboards — clients with a dashboard AND live products (dead ones hidden).
6. Websites (object_153) — scorecards + reports + wildcard lookup (below).
7. QA Report — run-on-demand: active clients w/ no dashboard (90d), no live
   product in 90d, SEO clients; plus month-over-month lost/gained scorecards.

## Websites section
Scorecards (active = client status Active):
  Total active · Smart 1 Sites · WordPress · Other platform · Web billing (H&M/mo)
Reports (buttons): Sites without platform · Active sites without H&M$ ·
  Domains we purchased · Sites by partner · Cancelled sites.
Wildcard search lists sites; click a row to see ONLY the filled-in fields.
Field map: platform field_2927 · status field_3193 · site name field_3112 ·
  partner field_3113 · H&M field_3050 (+freq field_3157, normalized to monthly) ·
  domain field_2925 · domain-purchased field_2964.
Current seed: 610 sites, 477 active, $24,113/mo H&M.

## Refresh (seed now, refresh later)
The "↻ Refresh" button in the header re-loads the JSON files from the server
(picks up whatever the latest committed data is). To pull NEW data from Knack:

  REACT_APP_KNACK_API_KEY=xxx REACT_APP_KNACK_APP_ID=yyy npm run refresh
  git add build/data/*.json && git commit -m "refresh" && git push

This re-pulls object_135 AND object_153 and overwrites the JSON (full replace,
so status flips / price edits / new records all reflect). Runs server-side only
— Knack blocks browser calls and the API key must stay private. A nightly
GitHub Action can automate it.

## Deploy
Push to main; Render serves the prebuilt folder. No build step, no OOM.
