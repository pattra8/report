# LPR OCR corrections and gate configuration — 2026-10-10

Verified at 23:37 Bangkok. User authorized LPR fixes and report deployment; report functions were deployed before camera settings were changed.

## Report changes

- Bare 11111 / UnKnown-11111 is unreadable/no plate and excluded from guard-score denominators.
- Reviewed errors resolve to registered resident plates before classifying Resident/Visitor. Old corrections are pinned to reviewed event IDs; new exact camera/direction rules start 2026-10-10 Bangkok.
- Canonical plate/house searches include reviewed aliases, resolve each event, and filter uncorrected query candidates.
- Direct registered plates take priority. A correction requires the canonical plate to remain assigned solely to the reviewed house.
- Historical Firestore source events and images are not rewritten.
- Agent C report-window recount uses the same resolver to compare consistent plate sets.

## Live report verification (no LINE sends)

| Night shift starting | Checked / known Visitor cars | Score | Still missing |
|---|---|---|---|
| 2026-10-08 19:00 | 5 / 5 | 100% | none |
| 2026-10-09 19:00 | 3 / 4 | 75% | 5ขค3343 |

Both production lprWatchRun calls returned HTTP 200 and lineSent=false. Previously sent LINE cards were not replaced or resent.

## Device review and change

Both devices are DS-TCG406-E. Before the change each had 160 allowlist records; ฎ6248 and ฆว3818 were present, while the reviewed OCR variants were absent. Recognition was enabled. Global fuzzy plate matching was disabled.

The live device WebSDK and GET /ISAPI/ITC/plateRecognitionParam/capabilities exposed native plateMappingRule with detectPlateNo / replacePlateNo. This permits exact correction inside the camera rather than adding more allowed plates or enabling global fuzzy matching.

| Camera | Native replacement |
|---|---|
| 8241 | ปฎ648 → ฎ6248 |
| 8241 | 8ฎ648 → ฎ6248 |
| 8241 | ฎฎ648 → ฎ6248 |
| 8241 | ฆจ3818 → ฆว3818 |
| 8242 | ฆจ3818 → ฆว3818 |

PUT /ISAPI/ITC/plateRecognitionParam returned HTTP 200 / statusCode 1 for each device. Fresh authenticated GETs verified enabled=true and every mapping. All recognition settings outside plateMappingRule and the complete normalized allowlist remained unchanged. Entrance/relay/control configuration was separately re-read and matched the pre-change XML. No reboot or open/close pulse was issued.

Device mappings are persistent settings, not dynamically linked to resident reassignment. Remove or review these mappings if the canonical plate changes ownership, a source variant becomes a real registered plate, or the vehicle changes plate. Backend report guards do not automatically rewrite camera configuration.

## Remaining verification

The user cannot test a real vehicle now. Configuration persistence is confirmed; physical barrier opening and device replacement of the next real OCR event remain unverified. Test ฎ6248 and ฆว3818 through the affected entry/exit direction, record Bangkok time and actual barrier result, then compare new Firebase camera events. Existing mappings cover only the confirmed exact errors, not arbitrary new OCR mistakes.

## Deployment and validation

- Project pattra8-54c3f, region asia-southeast1. Functions-only deployment.
- All 10 selected functions were confirmed ACTIVE through Cloud Functions v2 after deployment:
- guardAuditDaySummary — revision guardauditdaysummary-00040-wov, updated 2026-10-10T16:36:26.146615742Z
- guardAuditNightSummary — revision guardauditnightsummary-00040-qeg, updated 2026-10-10T16:36:25.507331862Z
- dailyTrafficSummary — revision dailytrafficsummary-00073-bep, updated 2026-10-10T16:36:21.149602278Z
- dailyTrafficReport — revision dailytrafficreport-00059-has, updated 2026-10-10T16:36:25.962803772Z
- overnightSecuritySummary — revision overnightsecuritysummary-00072-gab, updated 2026-10-10T16:36:28.043148478Z
- overnightSecurityReport — revision overnightsecurityreport-00046-bom, updated 2026-10-10T16:36:25.964541879Z
- lprWatchRun — revision lprwatchrun-00116-baq, updated 2026-10-10T16:36:28.427693925Z
- lineFlexRoutingAdmin — revision lineflexroutingadmin-00030-fen, updated 2026-10-10T16:36:11.317668569Z
- lprAgentCRun — revision lpragentcrun-00033-quw, updated 2026-10-10T16:36:03.648659645Z
- lprEventWebhook — revision lpreventwebhook-00040-cel, updated 2026-10-10T16:36:03.772920210Z
- ESLint passed; 347 tests passed; node --check and git diff --check passed. Test registry/IDs use synthetic data.
- Firebase CLI printed successful updates and Deploy complete, then exited with a local update-check/config-store error. Cloud function revision reads and live HTTP report results independently confirmed successful deployment.

## Local evidence / rollback

No credentials are stored in these evidence files. They are private temporary files on this machine:

- /private/tmp/pattra-mapping-before-8241.xml and /private/tmp/pattra-mapping-before-8242.xml: original recognition configuration.
- /private/tmp/pattra-mapping-after-8241.xml and /private/tmp/pattra-mapping-after-8242.xml: read-back configuration.
- /private/tmp/pattra-device-mapping.cjs: scoped authenticated review/apply with read-back checks and rollback on verification failure.
- /private/tmp/pattra-mapping-proof.json and /private/tmp/pattra-report-deploy-proof.json: compact verification evidence.

For rollback, read current device configuration first, replace only plateMappingRule with the original disabled/empty section, PUT the preserved full document to /ISAPI/ITC/plateRecognitionParam, and verify read-back. If the current rule section includes later work, remove only these reviewed pairs and preserve all other settings.
