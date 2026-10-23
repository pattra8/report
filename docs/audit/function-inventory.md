# Firebase function inventory

Authoritative implementation: `functions/index.js`. There are 48 named deployed
exports detected at audit time: 32 direct HTTPS handlers, 11 schedules, 3
Firestore document triggers, and 2 issue notifier triggers created by a factory.
Counts should be regenerated after exports change.

> Caller status describes this repository only. Do not remove an export based on
> this table without checking all Pattra subprojects and deployed request logs.

## Resident, access, and administration

| Export | Type | Purpose / primary data | Caller in this repo |
|---|---|---|---|
| `residentSheetSync` | HTTP | Sync resident records with Google Sheets | Not found |
| `residentPinAuth` | HTTP | Resident PIN auth and related actions | Not found |
| `adminAccessMatrix` | HTTP | Manage admin access records | Not found |
| `getResidentData` | HTTP | Read authenticated resident profile | `visitorboard/index.html` |
| `updateResidentData` | HTTP | Update resident profile and LPR sync state | Not found |
| `residentLprSyncBackfill` | Firestore update | Sync changed resident cars to LPR | Firestore event |
| `getLifestyleSurvey` | HTTP | Read resident lifestyle survey | Not found |
| `updateLifestyleSurvey` | HTTP | Write resident lifestyle survey | Not found |
| `getLifestyleSurveyStats` | HTTP | Aggregate survey data for admin | Not found |

Primary collections: `residents`, `resident_pins`, `resident_signatures`,
`admin_access`, `audit_log`, `lifestyle_surveys`.

## LINE, issues, and routing

| Export | Type | Purpose / primary data | Caller |
|---|---|---|---|
| `lineWebhook` | HTTP webhook | Shared LINE event ingress and visitor flow | LINE platform |
| `lineFlexRoutingAdmin` | HTTP | Configure LINE routing | Not found |
| `broadcastLineAnnouncement` | HTTP | Persist/broadcast announcement | Not found |
| `notifyLinePublicIssue` | Firestore create | Retired board notifier; disabled by `LEGACY_ISSUE_LINE_NOTIFY_ENABLED` | Firestore event |
| `notifyLinePrivateIssue` | Firestore create | Retired board notifier; disabled by the same switch | Firestore event |
| `estateIssues` | HTTP | Resident issue reporting and committee handling | `index.html` (`/report/`) |
| `estateIssueCleanup` | Schedule daily 03:30 | Purge issue media past retention | Scheduler |

Primary collections/config: `estate_issues`, `estate_issue_counters`,
`issues_archive`, `announcements`, `line_targets`, `system_config/line`,
`system_config/line_flex_routing`.

The estate issue feature may push LINE messages only to the Pattra Watch
sandbox group, hardcoded — see `functions/domains/issues/README.md`. The two
legacy notifiers stay exported for export-surface stability but never fire.

## Visitor intake

| Export | Type | Purpose | Caller |
|---|---|---|---|
| `visitorIntakeAdmin` | HTTP | Admin list/update/export visitor logs | Not found |
| `visitorIntakeCleanup` | Schedule daily 03:20 | Retention cleanup | Scheduler |
| `visitorIntakeReminder` | Schedule every minute | Incomplete intake reminder | Scheduler |
| `visitorDailySummary` | Schedule daily 00:05 | Daily report and LINE summary | Scheduler |

Primary collections/config: `visitor_intake_logs`, `visitor_intake_sessions`,
`visitor_daily_reports`, `system_config/visitor_intake`,
`system_config/visitor_daily`.

## LPR, traffic, and guard operations

| Export | Type | Purpose | Caller |
|---|---|---|---|
| `lprPlateSync` | HTTP | Push plate data to LPR system | Not found |
| `retryPendingLprSync` | Schedule 15 min | Retry resident plate sync | Scheduler |
| `dailyLprReconciliation` | Schedule daily 06:00 | Compare resident/LPR state | Scheduler |
| `lprReconciliation` | HTTP | Run/read reconciliation | Not found |
| `lprGuardLookup` | HTTP | Guard plate lookup | `lprcheck/index.html` |
| `lprEventWebhook` | HTTP webhook | Receive LPR traffic event | LPR appliance |
| `dailyTrafficSummary` | Schedule daily 19:15 | Day-shift (07:00–19:00) traffic card, sent 15 min after the shift | Scheduler |
| `dailyTrafficReport` | HTTP | Query/edit daily traffic report | `lprlog/index.html`, `visitorboard/index.html` |
| `overnightSecuritySummary` | Schedule daily 07:15 | Night-shift (19:00 prev. day–07:00) card, sent 15 min after the shift; doc id = morning date | Scheduler |
| `guardAuditDaySummary` | Schedule daily 19:30 | Day guard audit | Scheduler |
| `guardAuditNightSummary` | Schedule daily 07:30 | Night guard audit | Scheduler |
| `overnightSecurityReport` | HTTP | Read/manage overnight report | Not found |
| `lprWatchRun` | HTTP | Run LPR/NVR watch process | Not found |
| `lprImageSync` | Schedule every 15 min | Attach NVR images to events | Scheduler |
| `lprImageCleanup` | Schedule daily 03:40 | Purge LPR images older than 90 days | Scheduler |
| `lprVehicleVision` | Firestore update | Process newly linked vehicle image | Firestore event |
| `lprAgentCRun` | HTTP | Run Agent C checks | Not found |
| `lprAgentCEventAudit` | Firestore update | Audit changed LPR event | Firestore event |

Primary collections/config: `lpr_traffic_events`, `lpr_reconciliation_runs`,
`lpr_daily_traffic_reports`, `lpr_overnight_reports`, `lpr_vehicle_profiles`,
`lpr_unreadable_labels`, all `lpr_agent_c_*` collections, and LPR-related
`system_config/*` documents.

## Requests, polls, documents, waste, and payments

| Export | Type | Purpose | Caller in this repo |
|---|---|---|---|
| `submitRequest` | HTTP | Create GitHub-backed resident request | Not found |
| `cancelRequest` | HTTP | Comment/close GitHub request | Not found |
| `getPendingRequests` | HTTP | Read GitHub-backed requests | Not found |
| `pollAction` | HTTP multi-action | Poll/survey CRUD and voting | Not found |
| `adminDocumentVault` | HTTP multi-action | Committee document storage metadata/content | Not found |
| `submitBulkyWasteRequest` | HTTP | Create resident pickup request | Not found |
| `getMyBulkyWasteRequests` | HTTP | List resident pickup requests | Not found |
| `deleteBulkyWasteRequest` | HTTP | Delete resident pickup request | Not found |
| `editBulkyWasteRequest` | HTTP | Edit resident pickup request | Not found |
| `manageBulkyWasteRequests` | HTTP | Committee management actions | Not found |
| `managePickupRound` | HTTP | Configure pickup round | Not found |
| `pattraPay` | HTTP multi-action | Payment workflow and email | Not found |

Primary collections/config: `polls` and vote subcollections,
`admin_documents`, `bulky_waste_requests`, `pattra_payments`, and
`system_config/bulky_waste_round`.

## Inventory quality gaps

- Exports are not declared in a machine-readable registry.
- Domain ownership of helpers is inferred from proximity/naming.
- There is no versioned API contract or shared response schema.
- Caller coverage across sibling Pattra repositories is not yet indexed.
- Test exports (`__visitorTest` and any similar internal exports) should remain
  separate from the deployed-function inventory.
