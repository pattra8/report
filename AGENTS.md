# Pattra Report navigation

This file supplements the workspace-level repository guidelines. Read
`docs/audit/README.md` before architecture, backend, or cross-feature work.

## Fast navigation

- Firebase export composition root: `functions/index.js`
- Shared HTTP compatibility: `functions/platform/http.js`
- Firestore path registry: `functions/platform/firestore-paths.js`
- Admin permission policy: `functions/domains/auth/admin-access-policy.js`
- Resident car quota: `functions/domains/residents/car-quota.js`
- Payment repositories: `functions/domains/payments/`
- Visitor normalization/state: `functions/domains/visitors/`
- Current architecture and boundaries: `docs/audit/current-architecture.md`
- Export/domain inventory: `docs/audit/function-inventory.md`
- Firestore ownership/model: `docs/audit/firestore-data-model.md`
- External boundaries: `docs/audit/external-integrations.md`
- HTTP/auth/error conventions: `docs/audit/api-conventions.md`
- Cross-project callers: `docs/audit/workspace-callers.md`
- Page/backend alignment: `docs/audit/feature-alignment.md`
- Verified gaps and baseline: `docs/audit/findings.md`
- Target modules and migration gates: `docs/audit/target-architecture.md`

Search active source first. Exclude `node_modules/`, `.git/`, `dist/`, `backups/`,
generated outputs, and `*.bak*` unless the task explicitly concerns history or a
deployed artifact.

## Backend change protocol

1. Identify the domain, exported function, known callers, collections, auth
   policy, integrations, and trigger type before editing.
2. Search the whole parent Pattra workspace for the export name and URL; several
   sibling applications consume this backend.
3. Keep the deployed export name and current payload/response contract stable
   unless every caller is migrated deliberately.
4. Add or update a contract test before extracting a handler from `index.js`.
5. Keep `functions/index.js` as the Firebase composition root while domains are
   moved into modules.
6. Do not combine module extraction with schema migration, production data
   rewrite, or endpoint behavior changes.
7. Run `npm --prefix functions run lint` and `npm --prefix functions test`.
   Compare any failure with `docs/audit/findings.md`; do not hide a failing
   baseline by weakening assertions.
8. Never deploy without explicit user approval.

## Performance work

The system serves a small community. Prefer clear bounded queries and lower
perceived latency over scale-oriented infrastructure. Measure latency and
Firestore operations before changing query or schedule behavior.

## Essential safety only

Security review is limited to correct resident/committee boundaries, webhook
identity, data integrity, idempotency, and operational safety. Do not broaden a
normal architecture task into penetration testing.
