# Workspace-wide backend callers

This is a static scan of source files under the parent Pattra workspace for fixed
URLs matching the deployed Firebase Functions base URL. Generated `dist/` output
and backup copies were observed but are excluded from the primary ownership map.

## Active-looking source callers

| Backend export | Caller source(s) | Feature owner inferred from path |
|---|---|---|
| `residentSheetSync` | `Pattra Expense - backup resident-data 2026-04-15/` | Backup only; active owner unresolved |
| `residentPinAuth` | `Pattra Center/admin/index.html`, `pattra8-pay/src/lib/pattra8.ts` | Admin/resident access, payments |
| `adminAccessMatrix` | `Pattra Parking/index.html`, `Pattra Center/index.html`, `Pattra Center/admin/index.html`, `Pattra Center/line-flex/index.html` | Shared admin authorization |
| `getResidentData` | `Pattra Visitors/myvisitor/index.html`, `Pattra Parking/index.html`, `Pattra Center/index.html`, `Pattra Center/pickup/index.html`, `Pattra Report/visitorboard/index.html` | Shared resident profile/auth |
| `getLifestyleSurvey` | `Pattra Data/index.html` | Resident data/survey |
| `updateLifestyleSurvey` | `Pattra Data/index.html` | Resident data/survey |
| `getLifestyleSurveyStats` | `Pattra Center/admin/index.html` | Committee survey reporting |
| `visitorIntakeAdmin` | `Pattra Visitors/index.html`, `Pattra Visitors/myvisitor/index.html` | Visitor administration |
| `lineFlexRoutingAdmin` | `Pattra Center/line-flex/index.html` | LINE routing administration |
| `lprPlateSync` | `Pattra Center/admin/index.html` | Resident vehicle/LPR admin |
| `lprGuardLookup` | `Pattra Report/lprcheck/index.html` | Guard lookup |
| `dailyTrafficReport` | `Pattra Report/lprlog/index.html`, `Pattra Report/visitorboard/index.html` | LPR/visitor operational boards |
| `pollAction` | `Pattra Center/admin/index.html` | Poll administration; resident caller not yet found by fixed-URL scan |
| `adminDocumentVault` | `Pattra Center/insurance/index.html`, `Pattra Center/blueprints/index.html` | Committee documents |
| `submitBulkyWasteRequest` | `Pattra Center/pickup/index.html` | Resident bulky-waste request |
| `getMyBulkyWasteRequests` | `Pattra Center/pickup/index.html` | Resident bulky-waste request |
| `deleteBulkyWasteRequest` | `Pattra Center/pickup/index.html` | Resident bulky-waste request |
| `editBulkyWasteRequest` | `Pattra Center/pickup/index.html` | Resident bulky-waste request |
| `manageBulkyWasteRequests` | `Pattra Center/admin/index.html` | Committee pickup management |
| `managePickupRound` | `Pattra Center/admin/index.html` | Committee pickup configuration |
| `pattraPay` | `pattra8-pay/src/lib/payapi.ts` | Payment application |

## External or infrastructure callers

- `lineWebhook`: configured in LINE, not a browser caller.
- `lprEventWebhook`: configured in the LPR appliance/integration.
- Scheduled functions: invoked by Cloud Scheduler.
- Firestore triggers: invoked by document events.
- Manual/operations endpoints such as reconciliation and Agent C runners may be
  called from scripts or operator tools not visible as fixed URLs.

## Important conclusions

1. `functions/index.js` is shared infrastructure for several sibling projects,
   not only the HTML files in `Pattra Report/`.
2. Export names and existing request/response contracts must remain stable during
   reorganization.
3. The same access endpoints are cross-domain dependencies. `residentPinAuth`,
   `adminAccessMatrix`, and `getResidentData` should become explicit shared auth
   and resident-profile modules rather than being owned by one UI.
4. Backup and generated files create search noise. AI navigation instructions
   should prefer active source paths and exclude `backups/`, `dist/`, and
   `node_modules/` unless history or deployed artifacts are the question.

## Remaining evidence gap

A fixed-URL scan misses callers that construct URLs dynamically, call through a
proxy, or live outside this workspace. Before a contract change, combine exact
symbol search, source-owner confirmation, and deployed request logs.

