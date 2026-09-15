# External integration map

## Integration ownership

| Integration | Current responsibilities | Auth/config | Failure boundary |
|---|---|---|---|
| LINE Messaging API | push/reply, group summary, routing | channel secret/token plus Firestore routing config | Firestore write may succeed while notification fails |
| LPR cameras | plate sync and guard lookup | admin password, fixed camera bases | one camera may succeed while another fails |
| LPR event source | vehicle event webhook | event token | duplicate delivery must remain idempotent |
| NVR | image retrieval/sync | NVR password | event can exist before image is linked |
| Google Sheets API | resident sheet sync | function service-account token | sheet and Firestore can diverge |
| GitHub Issues API | resident requests | GitHub token | local request state depends on remote issue state |
| Vertex AI | LPR/visitor image understanding | service-account `GoogleAuth` | model latency/format changes must not corrupt event data |
| Resend | payment receipt email | Resend API key | payment verification may succeed while email fails |

## Target adapter rule

Each integration module should expose domain-level operations and return a typed
result describing success, retryability, remote identifier, and sanitized error.
It must not receive an Express request/response object or write unrelated
Firestore collections directly.

## Operational invariants

- LINE webhook signatures are verified before processing.
- LPR event IDs/deduplication survive retries.
- Multi-camera plate sync records partial results rather than claiming total
  success.
- Payment verification and receipt-email status remain separately observable.
- External error logs never contain resident PINs, access tokens, signatures, or
  complete sensitive payloads.
- A scheduled retry operates on a bounded pending set and can run twice safely.

## Navigation

Until adapters are extracted, search `functions/index.js` for:

- `api.line.me`
- `LPR_CAMERAS`
- `GoogleAuth` and Vertex model constants
- `api.github.com`
- `api.resend.com`
- `callSheetsApi`

