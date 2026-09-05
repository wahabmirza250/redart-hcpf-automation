# RedArt HCPF claim robot

Colorado Health First Colorado (HCPF / Gainwell) professional-claim robot for RedArt NEMT billing.

It fills the provider portal with Playwright, but it **does not guess** whether a claim already went out. A file-backed ledger survives Railway restarts. If Confirm may have fired and no Claim ID was captured, the trip is marked **uncertain** and will not be sent again until a human (or `/reconcile-claim`) searches the portal.

## Why it used to flake

- After Confirm it only scanned the first 3,000 characters for the exact words `Claim ID is`. If the sentence was lower on the page, or said `Claim ID:`, the robot returned no ID and looked “confused.”
- It waited on Playwright `networkidle`. Gainwell keeps ping requests open, so quiet days finished fast and busy days sat on a 10–15s timeout at every step.
- Job state lived only in RAM. A restart made the robot forget yesterday’s submits.
- Every claim opened a brand-new login, which locks the account overnight.
- Confirm used a hardcoded DNN control id (`ctr768`). Gainwell redeploys change that id.

## What it does now

- **Claim ledger** at `data/claim-ledger.json` — `submitted` / `already_on_file` never resubmit; `uncertain` never auto-retries.
- **Saved portal session** per account (`data/sessions/`) so the robot reuses cookies instead of logging in every trip.
- **Lockout stop** — if the portal says the account is locked, the circuit opens and the robot stops.
- **Claim ID is required** — full-page text, network HTML, then a same-session Search Claims lookup. The job does not finish as “done” without an ID unless it is marked `uncertain`.
- **No `networkidle` waits** — postbacks wait for the DOM and the next field, so runtime stays stable day to day.
- **ISO dates are written as MMDDYYYY** — `2026-07-01` used to be typed as `20260701` and fail the portal mask.
- **Search matches member + service date** — another claim for the same patient is not treated as this trip.
- **Add is not clicked again until the total is polled** — a slow Total Charged Amount no longer duplicates a service line.
- **One bad trip does not open the circuit** — only a portal lockout or a missing Claim ID after Confirm stops the queue.
- **Pre-submit search** on real `confirm_submit` — if HCPF already has that member + service date, Submit is not clicked.
- **Stable selectors** — `[id$=…]` suffixes, not `dnn_ctr722…` instance ids.
- Live debug logins are off unless `DEBUG_PORTAL=true`.

## Run locally

```bash
npm install
npx playwright install chromium
PORT=43147 npm start
```

Open [http://127.0.0.1:43147/app](http://127.0.0.1:43147/app) for the ledger. Health is `GET /health`.

Needed environment (same as production):

| Variable | Purpose |
|---|---|
| `BILLING_API_URL` | RedArt app base URL |
| `BILLING_API_KEY` | Public billing API key |
| `PORT` | HTTP port (Railway sets this) |
| `SUBMISSIONS_PAUSED` | `true` to block real Confirm clicks |
| `DEBUG_PORTAL` | `true` only when you need the live debug routes |
| `CLAIM_LEDGER_PATH` | Override ledger file location |
| `PORTAL_SESSION_TTL_MS` | How long to reuse a saved login (default 8 hours) |

## Real submit

`POST /submit-claim` with `mode: "confirm_submit"` and `i_understand_this_is_real: true`.

If the ledger says **uncertain**, call `POST /reconcile-claim` with `member_id` + `service_date` (search only). If a claim is found it is recorded and will not be sent again. Only set `mark_failed_if_missing: true` after a person has confirmed HCPF has no claim.

## Tests

```bash
npm test
```

This package never talks to HCPF during `npm test`.
