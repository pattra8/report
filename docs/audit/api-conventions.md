# API, authentication, validation, and error conventions

## Compatibility rule

Existing endpoints are unversioned and consumed by several sibling projects.
During modularization, preserve each endpoint's current request and response
shape. Shared helpers may remove duplication only when characterization tests
prove the same status, body, headers, and side effects.

`functions/platform/http.js` now owns the compatible CORS/cache headers, common
POST/OPTIONS method handling, and the existing `{ok: false, error: string}` error
shape. Lifestyle Survey is the first migrated endpoint group.

## Current success and error contract

- Successful legacy response: `{ok: true, ...endpointFields}`.
- Legacy error response: `{ok: false, error: "human-readable message"}`.
- Preflight: status 204 with empty body.
- Wrong method on migrated POST endpoints: status 405 and `Method Not Allowed`.
- Known operational error: use its numeric `err.status`.
- Unexpected error: status 500; log server-side without credentials.

Do not silently introduce `{data: ...}` or structured error objects until a
versioned contract and every caller are migrated.

## Authentication policies

| Policy | Intended callers | Current mechanism |
|---|---|---|
| Resident | resident-facing feature | normalized house number plus PIN verification |
| Committee permission | committee/admin feature | resident verification plus `admin_access` permission |
| Matrix manager | access administration | current superadmin boundary |
| LINE webhook | LINE platform | LINE request signature |
| LPR webhook/operator | LPR appliance or operation | configured event/admin token |
| Scheduled/Firestore | Firebase infrastructure | platform-triggered function |

Every extracted handler should name one of these policies explicitly. A handler
must not infer committee access merely because a resident PIN is valid.

## Validation placement

1. HTTP helper validates transport concerns: CORS, method, basic JSON contract.
2. Handler validator converts raw request values into a domain command.
3. Auth policy verifies the normalized identity and required permission.
4. Domain service enforces business invariants.
5. Repository receives normalized keys and bounded query parameters.

Validation errors remain compatible with current messages until clients are
versioned. New internal code should use stable error codes even if the adapter
still emits a legacy string externally.

## Logging

Log endpoint/action, sanitized house identifier when operationally needed,
duration, result, and external dependency outcome. Never log PINs, access tokens,
LINE signatures, full document numbers, or complete resident payloads.

## Migration checklist per endpoint

- Known callers are listed and searched workspace-wide.
- OPTIONS and wrong-method behavior is tested.
- Authentication/permission policy is identified.
- Validation and error responses are characterized.
- Firestore reads/writes and external side effects are listed.
- Export name is retained and covered by the export contract test.
- Unit/contract tests, lint, and diff checks pass before any deployment proposal.

