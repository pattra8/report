# Payment source recovery and backend audit

Audit date: 2026-08-04. Production access was read-only. No function, rule,
secret, Firestore document, or Storage object was changed.

## Executive finding

The original sources are recoverable:

- Deployed Cloud Function archives were downloaded and preserved as two exact,
  separate snapshots under `Pattra Functions Recovered/deployed/`.
- The original React/Vite project was found at `pattra8-pay/`.
- The payment model **does store an amount as a Firestore number**, but it does
  not have an installment ledger, contractual charge rows, or a stored per-house
  balance. The amount due is hardcoded as one common base for every house, with
  the house number encoded in the two decimal places. Installments therefore
  require a ledger/schema addition rather than only a UI calculation.

## Recovery provenance

Both targets are active Gen 2 functions in `asia-southeast1`, runtime
`nodejs24`, deployed with the Firebase CLI.

| Function | Deployed source object | Firebase source hash |
|---|---|---|
| `pattraPay` | `pattraPay/function-source.zip`, generation `1784957745780931` | `264dfd09c5fea68d44b579c562c5e81868dcbd8f` |
| `residentPinAuth` | `residentPinAuth/function-source.zip`, generation `1784135360715071` | `b9c4985a31b5fd1f11319bb243b36f0a3310f0ab` |

Every Gen 2 archive contains the full Functions package at that deployment's
point in time. The two recovered `index.js` files differ; payment findings below
use the `pattraPay` snapshot, while auth findings use the actual
`residentPinAuth` snapshot.

## A. Data model

### 1. Live Firestore collections

A live `listCollectionIds` call returned these top-level collections:

`admin_access`, `admin_documents`, `announcements`, `audit_log`,
`bulky_waste_requests`, `issues`, `lifestyle_surveys`, `line_broadcasts`,
`line_targets`, `line_webhook_events`, `lpr_agent_c_alerts`,
`lpr_agent_c_camera_status`, `lpr_agent_c_daily_metrics`,
`lpr_agent_c_event_audits`, `lpr_daily_traffic_reports`, `lpr_debug_events`,
`lpr_overnight_reports`, `lpr_reconciliation_runs`, `lpr_traffic_events`,
`lpr_vehicle_profiles`, `parking`, `pattra_counters`, `pattra_payments`,
`private_issues`, `resident_pins`, `resident_signatures`, `residents`,
`system_config`, `visitor_daily_reports`, `visitor_intake_logs`, and
`visitor_intake_sessions`.

Payment uses `pattra_payments`; the legacy upload inbox is
`pattra_slip_uploads` in code but was not present as a live top-level collection
at query time. Receipt sequence state is `pattra_counters/receipts`.

### 2–3. Payment fields and real redacted example

The following is one real production document read on 2026-08-04. PII, Storage
URLs/paths, HTML, and the document ID are redacted:

```json
{
  "id": "[REDACTED]",
  "houseNo": 64,
  "feeType": "common",
  "period": "H2",
  "year": 2026,
  "amount": 9600.64,
  "email": "[REDACTED]",
  "slipUrl": "[REDACTED]",
  "storagePath": "[REDACTED]",
  "source": "resident_upload",
  "createdAt": "2026-07-31T13:01:12.677Z",
  "adminNotificationSentAt": "2026-07-31T13:01:13.252Z",
  "adminNotificationStatus": "sent",
  "status": "verified",
  "payerName": "[REDACTED]",
  "receiptNo": "RC-2026-0063",
  "receiptHtml": "[REDACTED]",
  "receiptSentAt": "2026-07-31T13:47:09.808Z",
  "verifiedAt": "2026-07-31T13:47:09.808Z",
  "emailStatus": "sent"
}
```

`amount` is a Firestore numeric value, surfaced as a JavaScript `number`.
Depending on ingestion path, optional fields also include `paidAt`, `bank`,
`transactionRef`, `importFile`, `confidence`, `overage`, `rawNote`,
`reviewNote`, `note`, `legacyInboxId`, and `updatedAt`.

### 4. Where the amount due comes from

It is hardcoded, not read from Firestore or Google Sheets:

- Backend: `PP_COMMON_BASE = 9600`.
- Frontend defaults: `commonBase = 9600`, `parkingBase = 600`,
  `currentYear = 2026`.
- Common payment amount is `9600 + houseNo/100`, e.g. house 64 pays
  `9600.64`. The decimal is an identification mechanism, not a land-size fee.
- All houses currently share the same base. There is no land-area rate table,
  assessed-charge document, per-house obligation, balance, or installment plan.
- Generic `submitPayment` trusts the client-supplied positive amount; the
  special `submitCommonSlip` endpoint computes the hardcoded amount server-side.

### 5. Period format

- Common fee: `H1` or `H2`, with year stored separately as a number.
- Parking: `period = "YYYY-MM"`; `year` is also stored separately by the
  generic payment path.
- `publicStatus` uses a combined common key such as `"2026:H2"`, but parking
  keys remain such as `"2026-08"`.

## B. Current logic

### 6. `publicStatus`

It queries `pattra_payments` where status is `verified` or `pending`, then
returns only house-number arrays:

```json
{
  "ok": true,
  "status": {
    "common": { "2026:H2": [8, 21, 64] },
    "parking": { "2026-08": [4, 8] }
  },
  "pending": {
    "common": { "2026:H2": [12] },
    "parking": { "2026-08": [5] }
  }
}
```

`status` means verified; `pending` is a parallel object. It exposes no amount,
name, email, slip, receipt, or document ID.

### 7. `adminVerify` order of operations

1. Re-validates admin house + PIN and the access matrix.
2. In a Firestore transaction, reads the payment, reads
   `pattra_counters/receipts`, increments its `value`, and returns the payment
   snapshot plus allocated sequence.
3. Resolves payer name/email: explicit admin overrides, then payment fields,
   then the matching `residents` document.
4. Builds `RC-{year}-{sequence padded to 4}` and renders receipt HTML.
5. Sends the receipt email through Resend.
6. Updates the payment to `verified` with `payerName`, `email`, `receiptNo`,
   `receiptHtml`, `verifiedAt`, `receiptSentAt`, and `emailStatus`.
7. Returns receipt number, mail result, and HTML.

It does not write an audit-log row. Email happens before the final payment
update, so a post-email write failure can leave the stored state behind the
message already sent.

### 8. Receipt numbering and concurrency

The running integer is `pattra_counters/receipts.value`. A Firestore transaction
provides atomic increments, so concurrent allocations do not receive the same
sequence. Missing payment documents do not consume a number.

However, the transaction does not mark the payment verified/reserved or reject
an already verified payment. Two concurrent/repeated `adminVerify` requests can
allocate two different numbers, send more than one email, and leave gaps while
the last payment update wins. Number uniqueness is protected; verification
idempotency is not.

### 9. `adminPatchPayment`

Only a `pending` document can be patched. Allowed fields are `payerName`,
`email`, `bank`, and `reviewNote`, plus server-written `updatedAt`. It cannot
change house, fee type, period, year, amount, status, slip, or receipt fields.

### 10. `submitCommonSlip` duplicate detection

There is no image hash or transfer-reference check. A duplicate is:

- an existing `pattra_payments` row for the same house, `common` fee, hardcoded
  public period/year, with status `pending` or `verified`; or
- an unprocessed legacy `pattra_slip_uploads` row for the same house and
  period/year that has a slip URL.

### 11. `ocrSlip`

It uses Vertex AI multimodal vision (`generateContent`), not Cloud Vision API.
The response schema extracts `houseNo`, `amount`, sending `bank`, `payerName`,
and `confidence`. It can read the amount as a number; it is not limited to
date/reference extraction. The prefill call is read-only and sends the image
inline rather than saving it first.

## C. Authentication

### 12. `residentPinAuth` actions and levels

Resident-level actions:

- `verify` (default): verify own house/PIN.
- `change`: verify old PIN and set a new one.
- `reset`: identity check using at least two of name/email/phone, then set a new
  PIN.

Admin-level actions, each additionally checked against `admin_access`
permissions:

- `adminResidents`
- `adminUpdateResidentData`
- `adminReset`
- `adminAuditLogs`
- `adminStorageStats`

Admin is therefore not merely a boolean PIN level: the caller first passes
resident PIN verification and then needs an active permission in the admin
access matrix.

### 13. PIN storage

PIN documents are in `resident_pins`, keyed with `/` replaced by `_`. PINs are
not stored plaintext in Firestore. Each house has a random salt and
`pinHash = SHA-256(salt + ":" + six-digit PIN)`. This is salted but fast and not
a password-hardening KDF such as Argon2/scrypt/bcrypt/PBKDF2.

### 14. Rate limiting / lockout

Normal `verify`, `change`, internal admin verification, and other PIN-protected
requests have no rate limit or lockout; a failed verification only records
`lastFailedAt` and/or an audit row. The self-service `reset` identity flow alone
limits failed attempts to 20 per rolling hour per house. This does not provide
general six-digit PIN brute-force protection and is not IP-based.

### 15. Session token

There is no server session token. Successful `verify` returns only
`{ok:true, houseNo}`. Every protected request sends house number + PIN again and
recomputes the hash.

The shared web session is client-side: pages store
`{houseNo, pin, expiresAt}` in `localStorage` for 30 days. Pattra8 Pay also
persists admin credentials under `pattra8pay.creds` until sign-out, with no
independent server expiry. This is a plaintext reusable PIN in browser storage,
not a signed/opaque session, and should be replaced before adding sensitive
balance/installment views.

## D. Operations

### 16. Generation and runtime

Both target functions are active Cloud Functions Gen 2 (`gcfv2`) in
`asia-southeast1`, runtime Node.js 24.

### 17. Tests and deployment

The recovered package includes ESLint and Node's built-in test runner, plus
unit/contract tests and SIT/smoke scripts. Package commands include:

- `npm run lint`
- `npm test`
- `npm run test:sit`
- `npm run smoke`
- `npm run deploy` -> `firebase deploy --only functions`

Deployed labels say `deployment-tool=cli-firebase`. No checked-in GitHub Actions
workflow was found in the recovered package, so there is no evidence of CI
deployment from this source.

### 18. Environment variables and secrets (names only)

Target bindings:

- `pattraPay`: `LPR_ADMIN_PASSWORD`, `RESEND_API_KEY`
- `residentPinAuth`: `LPR_ADMIN_PASSWORD`

The full shared source also declares `GH_TOKEN`, `LINE_CHANNEL_ACCESS_TOKEN`,
`LINE_CHANNEL_SECRET`, `LPR_EVENT_TOKEN`, and `LPR_NVR_PASSWORD`. Platform-set
variables include `FIREBASE_CONFIG`, `GCLOUD_PROJECT`,
`EVENTARC_CLOUD_EVENT_SOURCE`, `FUNCTION_TARGET`, `LOG_EXECUTION_ID`, and
`FUNCTION_SIGNATURE_TYPE`. Values were not collected into this report.

### 19. Deployed Firestore rules

The active ruleset was read from Firebase Rules API. It grants unrestricted
client read/write access only to `issues`, `private_issues`, `announcements`, and
`parking`. All unmatched paths are denied by default.

Therefore browsers cannot directly read/write `pattra_payments`,
`pattra_counters`, `resident_pins`, `residents`, or `admin_access`; payment and
resident data go through Cloud Functions using the Admin SDK. Note that the
recovered frontend project's local `firestore.rules` mentions old collections
such as `payments` and `public_status`; it is stale and is not the deployed
ruleset.

## Installment-design consequence

This is not a status-only system: payment rows already contain actual amounts,
and OCR reads amounts. But it is also not yet a ledger. A safe installment
design needs, at minimum, immutable assessed charges per house/period, one or
more payment allocations against a charge, derived outstanding balance,
idempotent receipt issuance, and a real expiring server session. Existing
`pattra_payments` rows can be migration inputs, but should not be overloaded as
both obligations and cash movements.

## Verification performed

- Both recovered deployment snapshots pass `node --check` for `index.js` and
  every extracted domain/platform module.
- Active `Pattra Report/functions`: ESLint passed; 183/183 Node tests passed.
- Recovered `pattra8-pay`: TypeScript and the Vite production build passed.
- Frontend ESLint has a pre-existing baseline of 13 errors, primarily React 19
  effect/fast-refresh rules plus two explicit-`any` findings. No application
  source was changed to hide that baseline during recovery.
