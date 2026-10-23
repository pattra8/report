# Four resident vehicles: ANPR and barrier review — 2026-10-16

User authorized debugging and fixing entry/exit access for all four named vehicles, including red-plate nighttime visibility. Inspection began at15:47 Bangkok. Physical access verification is incomplete; the user cannot currently coordinate trials.

## Identity and access

Fresh Firestore reads selected only cars and house fields. Authenticated exact camera searches found whiteList records for all four canonical plates on BOTH devices, valid until2099-12-30. Neither contains ฎ6428. The daylight photo is ฎ-6248; the normalized registry is ฎ6248.

| House | Canonical plate | Exact entry/exit reads,9–16Oct as of15:47 | Assessment |
|---|---|---|---|
|38/18|ฆว3818|1/4|Some entry captures are still wrong; see below|
|38/60|ฎ6248|3/6|Correct reads both ways; historical entry variants reviewed|
|38/48|ฎภ8842|0/0|Only two historical exact exit reads,5and7Aug; current access unknown|
|38/34|กท82|18/17|Continuous reads both ways; physical automatic opening unrecorded|

Both devices have ctrlMode=0 (By Camera, verified from their own English UI). The active /ISAPI/Parking/VehicleReleaseRulesParams?format=json enables registered vehicleType0 allDay; blocklisted, temporary, special and no-plate release are disabled. These newer rules matter: legacy vehInfoManag barrierGateOper0 alone is not evidence registered release is disabled. Existing relay1function1/relay2function2 and350ms remain unchanged.

GET /ISAPI/Parking/channels/1/barrierGate/barrierGateStatus returns0 for both. The device UI defines0 as checking whether opening/closing limit feedback is connected, not an open/closed state. API/snapshot health and ANPR capture do not prove barrier movement.

## Confirmed mismatch before report parsing

Four entry events say plate/rawPlate ฎ62480 while the associated Mazda photo visibly shows ฆว3818. User confirmed the first photo; the other three were visually inspected.

| Bangkok time | Event ID |
|---|---|
|12Oct20:12:30|93d073c88baea89501be2bd53b13c3eac2e86b5a|
|13Oct19:25:38|759224b4116f3bddcf33034fe72c667b5073ef12|
|14Oct20:39:19|a6391621e70543ed247ee7f98a0267e671d23c7f|
|15Oct18:01:15|757b12e5ffcce0e394537947084b22ea663a7dd5|

Cloud Logging raw notification at2026-10-12T13:12:32Z includes licensePlate=ฎ62480, confidence94 and matching camera dateTime. The NVR overlay also says ฎ62480. This is upstream of report parsing. It is NOT evidence to map ฎ62480 to the red-plate vehicle ฎ6248.

Entry had three native mappings to ฎ6248 plus one to ฆว3818. Exit had only ฆจ3818→ฆว3818. Multi-rule entry mapping is a plausible cause to isolate, NOT proven causality or a confirmed firmware defect. A new evening Mazda capture is needed after isolation.

## Live mitigation at16:00 Bangkok

- Removed only entry native replacements ปฎ648→ฎ6248,8ฎ648→ฎ6248,ฎฎ648→ฎ6248.
- Added those three exact, image-reviewed entry OCR variants as allowlist aliases. Current canonical ownership was freshly verified as solely house38/60; none belonged to another registered resident.
- Retained ฆจ3818→ฆว3818 as the sole entry mapping. Exit configuration remains unchanged with that single rule.
- Entry list160→163; full set comparison proved all original plates retained and only those three added. Exit remains160. Every canonical plate remains authorized both ways.
- Readback verified mapping contents, recognition XML outside plateMappingRule, full entrance/relay XML and active release-rule JSON. No fuzzy matching, barrier pulse, reboot, exposure or lighting change.
- First apply failed a local array assertion across VM realms. Automatic rollback restored baseline mapping and removed its three additions. Fresh preflight reverified the160-record baseline; the corrected value comparison passed on the second apply.

This is a mitigation/diagnostic isolation, NOT proof the next pass works. If Mazda still outputs ฎ62480, inspect the next raw notification/image before another change. Do not add ฎ62480 as a catch-all or grant an unreadable/similar-number plate.

Aliases are persistent records with2099 expiry following existing camera records, tagged in plateDescription as OCR aliases for ฎ6248 house38/60. They are not resident registry vehicles. Review/remove on canonical vehicle/owner changes or if an alias becomes an actual plate. Reconciliation preserves LPR-only records; alias retirement is not automatic.

Local policy sets nativeMapping=false for the red-plate rule, so maintenance mapping generation skips quarantined rules while reports/search retain their reviewed corrections. No function deployment needed: this builder has no production ingestion/gate caller.

## Red plates and night visibility

- ฎ6248 is red, confirmed by16Oct10:09:45 daylight image. Night entry photos7Oct01:54:45 and8Oct22:04:26 misread ปฎ648/8ฎ648 but the real plate remains legible, with headlight glare. Exact entry images13Oct19:39:13 and15Oct20:46:11 also show legible ฎ-6248. There is insufficient evidence to label these confirmed insufficient-light failures.
- ฆว3818 has a white plate visible in reviewed photos despite wrong output. Darkness alone does not explain this error.
- Entry13Oct23:02:38,e456a5224d7262d965138afddb0044672ee52a8a,reads ฮภ8843. Image is blurred/dark around the plate with strong headlight glare. User also could not read it. Neither vehicle identity as ฎภ8842 nor red-plate status is established. No access alias/correction created.
- Historical exact ฎภ8842 exit7Aug06:18:55 shows a white Honda/white plate. No readable recent entry established.

Entry settings read: brightness50,gain50,manual exposure,ShutterLevel5000,HLC light-controlled,plate-bright enhancement disabled. No uncalibrated global image change without a night trial. Manufacturer guidance covers exposure, capture angle and fill lighting: [DS-TCG406-E setup](https://display.hikvision.com/content/dam/hikvision/en/support/how-to/how-to-document/entrance-and-exit-parking/How-to-configure-DS-TCG406-E.pdf).

## Validation and completion requirements

ESLint and358tests passed; node syntax and git diff checks passed. Final fresh read at16:01:13 verified entry163/exit160, canonical membership on both, retained mappings and healthy ANPR status. No LINE sends, resident rewrite, report resend or unrelated code changes.

Completion requires a new identifiable capture for EACH plate in EACH direction and an observed automatic barrier outcome (guard/driver or reliable position feedback/video). Include evening entry for ฆว3818 after isolation, a readable current pass for ฎภ8842, and a night pass for the red plate before lighting tuning. User currently cannot arrange this; goal remains incomplete.

Private local evidence: /private/tmp/pattra-entry-review-before.xml,pattra-entry-review-after.xml,pattra-entry-review-proof.json,pattra-four-final-proof.json,pattra-raw-mismatch-logs.json,pattra-four-validity-result.txt,pattra-lpr-oct16-tests.txt. No credentials in these files; do not publish resident exports.

Rollback: fresh live reads first; remove only the three alias records introduced here and restore only the removed native pairs, preserving later changes. Restoring suspected mapping is not recommended before diagnosis.

## Final check before overnight observation

16Oct16:17:57 Bangkok: fresh device reads confirm all four canonical plates still present on both cameras, entry163/exit160, the three reviewed entry aliases retained, and only ฆจ3818→ฆว3818 retained in each native mapping list. Four new traffic events occurred after the16:00:18 mitigation, but none matched the four target vehicles or their reviewed variants. Both barrier feedback values remain0, so no physical opening outcome is established. Git diff whitespace check passed. User will return tomorrow; no scheduled monitor or LINE notification was created. Compare subsequent raw events and images against this baseline before claiming resolution or making further camera changes.

## Follow-up 18 October, 12:00 Bangkok

Read-only live check: 435 stored traffic events since16Oct16:00:18.025. Registry ownership and both camera allowlists still match the baseline (entry163/exit160). All four canonical plates remain authorized. Entry aliases and the single native mapping on both cameras remain intact. Registered-vehicle automatic release is enabled all day on both; barrier feedback is still0 and target matchingResult fields are empty, so physical automatic opening is unverified.

- กท82: three exact entries and three exact exits. Latest18Oct11:15:06 entry and11:37:36 exit; both linked images visually confirm the actual plate.
- ฎ6248: no exact canonical event, but16Oct19:51:27 entry496be88180b7e3e0abb23df895de4238aeeaab57 readsฎฎ648. Linked image clearly showsฎ-6248 on the silver XPeng. This proves OCR still misreads it; the exact alias remains authorized on entry. Local report resolver returnsฎ6248 for this event. No identified exit in this interval.
- ฆว3818 andฎภ8842: no exact or previously reviewed variant event in this interval. No recurrence ofฎ62480 found, but without an identified Mazda pass this does not prove the suspected interference resolved.
- Checked nearby digit candidates and visually inspected all five blank-plate events plus11115. Four blank events and11115 depict an unregistered-plate Toyota with a dealer panel; the remaining blank event shows a motorcycle. These images do not establish a pass by either missing target vehicle. This is not an exhaustive visual identification of all435 captures.

Both ANPR status documents were healthy at11:59. No new production writes, deploy, gate actuation or LINE send in this follow-up. Private evidence is in /private/tmp/pattra-oct18-evidence.json and images /private/tmp/pattra-oct18-image-0.jpg through-2.jpg; unknown images use pattra-oct18-unknown-0.jpg through-5.jpg.

## OCR reasoning for the clear 16 October image

18Oct follow-up raw Cloud Logging trace at16Oct12:51:29.105555Z confirms camera notification licensePlate=ฎฎ648, confidenceLevel87, plateCharBelieve=91,99,58,99,99, plateType=unknown, plateColor=White and licenseBright203. Stored event retains rawPlate=plate=ฎฎ648. The report normalizer only removes whitespace/hyphens and normalizes Unicode; it does not generate this substitution. Live native mapping still only replacesฆจ3818, so no current red-plate replacement explains this event.

Actual normalized string has five characters ฎ|6|2|4|8; output also has five ฎ|ฎ|6|4|8. An alignment shows two character substitutions, not proven insertion/deletion. A Thai temporary-plate layout/model interpretation error is plausible (one letter plus four digits interpreted as two letters plus three digits), but neither the proprietary decoder nor its exact input crop is available, so this is a hypothesis. Current countryIndex64/nationAPAC and nonStandardPlateRegEnabled=true mean merely enabling Thailand/nonstandard recognition is not an established fix.

The clear attached photo is a separately linked NVR image; stored imageMatchDeltaMs1390 means it is not proof of the exact OCR input frame/crop. Do not assert that darkness, glare, a hyphen, a template rule or a firmware defect is the proven root cause. Reviewed alias access mitigates the downstream consequence; it does not repair the recognition model.

Manufacturer schema consulted: https://open.hikvision.com/hardware/v2/XML%E6%96%87%E4%BB%B6/XML_EventNotificationAlert.html defines plateCharBelieve as per-character confidence. It labels barrierGateCtrlType as a historical gate flag (0 opened,1 not opened); this event has1 with alarmDataType0 (real-time), so do not reinterpret it as proof of an open command or physical gate movement. Private raw evidence: /private/tmp/pattra-ocr-raw-logs.json.

## Exact alias access on both directions, 18 October 12:07 Bangkok

User explicitly authorized hardcoded recognition-error access so registered residents can enter/exit. Fresh preflight found no resident assignedฎฎ648 and canonicalฎ6248 assigned solely to38/60. All-time exact query returned25 events (23 entry,2 exit). The two historical exit event attachments,8666fb08dcb51e0393c25b92f84d9d44eaf0de2e and96a5d97cc4571ca7a2752c9e6fb67e3f61bf6ab7, visibly show the silver XPeng withฎ-6248. Their images use the entry viewpoint despite event cameraId8242, so they corroborate the vehicle/plate mismatch but are not independent proof of exit-camera imaging or barrier movement. No assertion that every past/future occurrence ofฎฎ648 must be this vehicle: not all25 images were reviewed and another vehicle could produce the same OCR string.

Entry already authorizedฎฎ648. Added exactly that alias to exit8242, tagged as reviewed OCR alias forฎ6248/38/60, with2099-12-30 expiry matching current canonical records. Verified18Oct12:07:42: exit160→161, original set plus onlyฎฎ648; entry163 unchanged. Full recognition config, entrance/relay config and active release rules are byte-for-byte unchanged on exit. Exact record readback confirms whiteList. No native red-plate replacements restored, no fuzzy access, no gate actuation or LINE send. This is device configuration; no Firebase deployment or source-code change required.

Fresh full-registry coverage check18Oct12:07:58 found150 distinct registered car plates, all present on BOTH camera lists (missing0/0). This proves membership, not the next recognition outcome or physical barrier opening. No new resident ownership data was written. Reviewed aliases remain persistent; remove/review when canonical ownership changes or a collision is discovered.

Entry report normalization already coversฎฎ648. Exit access was added independently: the report correction module currently has noฎ6248 exit rule, so do not claim that exit report normalization was changed/deployed in this step. Pending end-to-end requirement remains an identifiable actual pass and automatic barrier outcome after this change.

Private mutation/readback evidence: /private/tmp/pattra-alias-preflight.json, /private/tmp/pattra-alias-exit-before.json, /private/tmp/pattra-alias-exit-proof.json, /private/tmp/pattra-all-resident-coverage.json. To roll back this step, fresh-read first and remove only the18Oct exit aliasฎฎ648; preserve all existing canonical plates and16Oct entry aliases.
