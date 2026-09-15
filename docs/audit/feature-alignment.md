# Feature alignment map

## Verified page-to-backend paths

| Page | User capability | Backend path | Data path | Alignment note |
|---|---|---|---|---|
| `index.html` | Public/private issue board | Direct Firebase Web SDK | `issues`, `private_issues` | Does not share HTTP API conventions |
| `lprlog/index.html` | Daily LPR log | `dailyTrafficReport` | LPR events/reports/labels | One multi-action endpoint serves reads and edits |
| `lprcheck/index.html` | Guard plate lookup | `lprGuardLookup` | residents/LPR profiles | Dedicated read endpoint |
| `visitorboard/index.html` | Visitor/traffic board | `dailyTrafficReport`, `getResidentData` | traffic reports and residents | Cross-domain dependency should be explicit |

## Unresolved alignment

The landing page at `https://pattra8.com/` exposes more services than the four
pages in this repository. A static workspace-wide scan found clients for many of
them in sibling Pattra projects; see `workspace-callers.md`. Static search still
cannot prove which copy is deployed or capture dynamic/external callers, so
production logs remain the authority before changing a public contract.

## Contract inconsistencies to normalize

1. CORS is usually applied with `setCorsHeaders`, but some LPR handlers set
   headers inline and webhooks intentionally use another pattern.
2. Most endpoints require POST, while `residentSheetSync` also has GET behavior.
3. Error text varies (`Method Not Allowed`, `POST only`, different status choices).
4. Authentication is expressed as raw secret tokens, resident PIN verification,
   access-matrix permissions, committee verification, or webhook signature.
5. Several endpoints multiplex many `action` values, but there is no central
   action contract or generated client mapping.

## Performance review targets

These are review targets, not confirmed defects:

- `.collection(...).get()` calls that read complete resident, PIN, poll, payment,
  or report collections.
- Scheduled functions that run every minute or every 15 minutes even when no work
  exists.
- Report endpoints that rebuild derived data instead of reading a current report.
- Repeated resident PIN/access lookups in a single request.
- Browser-side array read/modify/write for votes and replies.
- Missing composite indexes beyond the single visitor index currently declared.

Each target needs query cardinality, production latency/log, and read-count
evidence before optimization.
