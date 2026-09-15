# Verified baseline findings

Audit date: 2026-07-11. This file separates verified evidence from optimization
hypotheses. No production write or deployment was performed.

## F-01 — Backend navigation and change isolation are poor

- Priority: P1 maintainability / delivery speed
- Evidence: `functions/index.js` is 12,627 lines and contains 47 deployed exports
  spanning resident access, LINE, visitors, LPR, issues, polls, documents, bulky
  waste, and payments.
- Impact: AI and developers must infer domain boundaries from names and proximity;
  impact analysis and safe parallel changes are slower than necessary.
- Direction: retain `index.js` as a stable composition root while extracting
  tested domain modules incrementally.

## F-02 — The repository cannot prove whole-website alignment

- Priority: P1 architecture visibility
- Evidence: four HTML entry points are present here, but the production landing
  page links to Resident Profile, Parking, Announcements, Insurance, Blueprints,
  Expense, Payment, LPR, and Visitor services. Most backend exports have no caller
  under this repository.
- Impact: an AI agent can incorrectly label a function unused or change a payload
  consumed by a sibling project.
- Direction: build a workspace-wide caller index and verify deployed request logs
  before changing public contracts.

## F-03 — Frontend data access has two architectural paths

- Priority: P1 consistency / integrity
- Evidence: `index.html` directly reads and writes `issues` and `private_issues`;
  the LPR and visitor pages call HTTPS Functions.
- Impact: validation, authorization, errors, observability, and concurrency
  behavior cannot be applied consistently across features.
- Direction: document ownership now; migrate direct writes only with compatibility
  tests and a deliberate client transition.

## F-04 — API conventions vary by handler

- Priority: P2 developer/AI efficiency
- Evidence: shared `setCorsHeaders` is common, while `lprGuardLookup` sets its own
  headers; method errors include both `Method Not Allowed` and `POST only`; auth
  may use resident PIN, access matrix, secret token, or webhook signature.
- Impact: client and test code must learn each endpoint separately.
- Direction: extract compatibility wrappers first, then converge response shapes
  without breaking existing clients.

## F-05 — Visitor label test drifted from the active UI contract (resolved)

- Priority: P1 migration gate
- Evidence: `npm --prefix functions test` reports 129 passed and 1 failed. The
  `visitorPurposeLabel("food_delivery")` implementation returns
  `ส่งอาหาร (Food Delivery)` while the test expects `ส่งอาหาร`.
- Cross-check: both active Visitor HTML clients display the same bilingual label,
  and the implementation change is present in the current worktree diff.
- Resolution: update the stale test expectation to the bilingual label. No runtime
  implementation or production data was changed.

## F-06 — Automated coverage is concentrated in Visitor Intake

- Priority: P1 refactor safety
- Evidence: the unit suite targets exported visitor pure helpers. Deployed smoke
  checks cover four negative/liveness paths, and SIT targets Visitor Intake plus
  the LINE signature gate. There are 47 deployed exports.
- Impact: most function contracts and cross-domain flows are unprotected during
  reorganization.
- Direction: add export-set and endpoint contract tests domain by domain before
  moving handlers.

## F-07 — Performance opportunities need measurement, not guessing

- Priority: P2 performance
- Evidence: the backend contains multiple complete collection reads and frequent
  schedules, but the codebase has no checked-in latency/read-count baseline.
- Impact: premature optimization could complicate a system serving 68 homes
  without noticeable benefit.
- Direction: instrument slow endpoints and Firestore read counts, then optimize
  only measured bottlenecks. Prioritize perceived response time and AI/code
  clarity over scale-oriented architecture.

Resolution started: payment resident resolution now performs one direct resident
document read on the normal path instead of scanning all residents. A legacy-ID
fallback preserves old-record behavior and has focused unit coverage.

## F-08 — Payment receipt allocation lacked an atomic existence check (partially resolved)

- Priority: P1 data integrity / operational behavior
- Evidence: the `adminVerify` path increments `pattra_counters/receipts` in a
  transaction before it reads the target payment document and returns 404 when
  that document is missing.
- Impact: an invalid or repeated operator request can consume receipt sequence
  numbers; concurrent verification behavior is not protected by one transaction.
- Resolution: payment existence and counter increment now occur in one tested
  transaction, so a missing payment cannot consume a receipt number.
- Remaining: duplicate/concurrent verification and receipt-email idempotency need
  a separate reservation/state design before they can be considered resolved.

## Verification baseline

| Check | Result |
|---|---|
| `npm --prefix functions run lint` | Pass |
| `npm --prefix functions test` | Pass: 151 of 151 tests after HTTP, auth, resident, payment, and visitor extraction coverage |
| Production deployment | Not run |
| Production mutation test | Not run |
| Current export count | 47 |
