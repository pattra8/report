# ANPR outage exemptions and Pattra Watch alerts

Deployed on 2026-10-12 at approximately 14:17 Bangkok after explicit user approval.

## Behavior

- ANPR freshness warns after one hour and escalates after two hours, only when the other camera has a capture within 30 minutes and at least five peer events have accumulated. Three consecutive stale probes confirm the outage (the scheduler runs every two minutes). Quiet traffic alone does not prove a failure.
- Confirmed physical camera failures also open an outage window. Windows remain active until a genuinely newer ANPR capture is observed with a successful physical probe; API/snapshot recovery alone is not ANPR recovery.
- Camera status documents retain closed windows for 35 days, capped at 256 per camera. Existing event/visitor records are not rewritten. Historical outages before this version are not reconstructed automatically.
- An unmatched Visitor plate gets the benefit of the doubt when at least one of its captures falls in a confirmed outage of either camera. It is removed from the unchecked list and credited in the score as `excusedCars`; `checkedCars` still means actual guard logs. A healthy unmatched capture still costs points.
- Example: three known cars, one checked, one outage exemption, one healthy unmatched => 67%, with one unchecked plate. When every remaining unmatched car is exempt, the score can be 100% and the Flex explicitly explains the exemptions.
- Daily/night guard Flex and weekly safety aggregation share this rule. No records means no score rather than a fabricated 100%.
- Operational health alerts always use the fixed registered Pattra Watch target, independent of optional Agent C/Gemini/backlog settings. Initial warning, critical escalation and actual-event recovery use distinct incident fingerprints. Successfully delivered incident alerts do not repeat; failed pushes release the cooldown for retry. Physical API/snapshot recovery wording no longer claims ANPR recovery.
- Alert links point to the existing committee system-health page for a manual reboot. No automatic reboot is introduced.

## Validation

`npm --prefix functions test`: 358 tests passed.
`npm --prefix functions run lint`: passed.
`node --check functions/index.js`: passed.

Synthetic tests cover healthy scoring, active and closed outages, repeated plates, boundary times, actual versus exempt counts, quiet-road persistence, new-event recovery, fixed Pattra Watch routing with AI disabled, duplicate suppression and failed-push retries. No test sends LINE or reads resident data.

## Release scope

Approved and deployed exports:

- `guardAuditDaySummary`, `guardAuditNightSummary`, `lprWatchRun`, `lineFlexRoutingAdmin` (guard/weekly report callers)
- `systemHealthProbe`, `systemHealthAdmin`, `lprAgentCRun` (all health probe callers must use the same thresholds/state tracking)

Firebase project: `pattra8-54c3f`, region `asia-southeast1`.

The checkout contains unrelated uncommitted payment/frontend/rule changes. Preserve them and do not deploy those exports or Firestore rules/indexes. Selected Firebase exports still share the composition-root source, so review the existing changes within each selected export before release.

## Live verification

Firebase login succeeded. Read-only Firestore verification at 2026-10-12 14:13 Bangkok:

- Both physical probes were OK; current event status was online.
- Latest actual traffic capture: entry 14:12:00, exit 14:12:51 (Bangkok).
- Read 344 projected traffic events since 2026-10-11 00:00, selecting only camera ID and capture epoch. The 5,000-row bound was not reached.
- Exit capture gap on 2026-10-11: 13:27:26–18:04:49 (277 minutes), while entry recorded 48 events.
- Exit capture gap spanning 2026-10-11/12: 18:27:36–03:22:32 (535 minutes), while entry recorded 36 events.
- These are confirmed ingestion gaps with peer activity, not proof of the exact device failure cause.
- `system_config/lpr_agent_c.enabled` is false; `backlogMonitorEnabled` is absent. The old shared alert gate therefore suppresses operational health notifications. The prepared change removes that dependency for fixed-target Pattra Watch health alerts.

The diagnosis above was read-only. Historical outages are not automatically backfilled; the new exemption history begins with observations after deployment. Existing published cards remain unchanged.


## Deployment verification

Firebase CLI completed successfully (exit 0). Cloud Functions v2 API independently confirmed all seven exports ACTIVE with updates at 07:16 UTC / 14:16 Bangkok:

| Function | Active revision |
|---|---|
| guardAuditDaySummary | guardauditdaysummary-00041-vib |
| guardAuditNightSummary | guardauditnightsummary-00041-ped |
| lprWatchRun | lprwatchrun-00117-lac |
| lineFlexRoutingAdmin | lineflexroutingadmin-00031-saz |
| systemHealthProbe | systemhealthprobe-00008-bad |
| systemHealthAdmin | systemhealthadmin-00005-buj |
| lprAgentCRun | lpragentcrun-00034-poh |

The scheduled probe at 14:17:06 Bangkok wrote the new `activeAnprOutage`, `anprOutageWindows` and `physicalFailureSinceEpoch` fields on both camera documents. Both cameras were online with no active outage.

A production `lprWatchRun` guard-audit request for 2026-10-12, with explicit Pattra Watch target and `sendLine:false`, returned HTTP 200, `ok:true`, `lineSent:false`. The partial day report had 13 known cars, 9 actual checks, 0 outage exemptions, 4 unmatched cars and 69%. The new exemption field confirms the deployed report path is running. No historical exemption was invented to alter that score.

No manual LINE message or reboot was issued. Future operational alerts are enabled by the deployed scheduler code and fixed to Pattra Watch. No outage was simulated in production to force delivery. Source tests cover the outage/delivery paths (358 passed), and Firebase predeploy lint passed again.
