# Visitor OCR recovery review — 2026-09-10

## Verified incident

Production LINE worker logs show saved visitor images timing out at 45 seconds.
The old handler swallowed that failure, persisted `kind: other` with no analysis,
and completed the webhook event. My Visitor also displayed `partial` as if OCR
was still running. These are backend failures, not missing physical photos.

The read-only audit from September 3 onward covered every house. The latest
snapshot contained 621 records: 43 records have now been recovered, including
all seven affected records for 38/8. There were still 28 records with missing
analysis (32 images), including one record without a house assignment. This is
an interim snapshot, not a claim that all historical records are repaired.
Recovery used existing images in the project's existing Vertex service, filled
only absent aggregates, used Firestore update-time preconditions, and retained
original visit timestamps, images, existing values and house assignments. No
retrospective LINE messages were sent.

## Implemented protection (not yet deployed)

- Each OCR request has a 60-second timeout, with up to three immediate attempts.
- Saved images get a durable `ocrRetryAt` job before OCR begins. A dedicated
  `visitorIntakeOcrRecovery` schedule handles up to two due records per run,
  one image per record, with leases and a nine-attempt image budget. Successful,
  expired, purged and permanent-error images are excluded. Exhausted jobs stop
  with a visible failure status instead of remaining pending indefinitely.
- The webhook records its original `visitorLogId` atomically. Replays reuse
  saved images and completed text events; they do not follow a newer session.
- Worker/recovery leases prevent overlapping work. Attempts are reserved before
  slow calls so a process crash cannot create an unlimited retry loop.
- New OCR fills missing fields and preserves typed/manual corrections. Delayed
  results do not recreate deleted/moved images or deleted records.
- My Visitor and the committee Visitor page distinguish active OCR, queued
  recovery, permanent OCR failure, partial data and missing physical photos.
- Pending OCR does not cause the text-event reply to falsely ask for replacement
  photos. Recovery itself does not send LINE messages.

## Validation and release

Local ESLint passes. The full suite passes 266 tests, including timeout recovery,
permanent errors, retry exhaustion, concurrent scheduler runs, deleted/moved
images, concurrent manual changes, original-record replay binding and document
numbers without names. Both frontend scripts compile and their status logic was
checked. Earlier layout verification passed at 360/390/430 and 1280px.

Release requires explicit approval under `Pattra Report/AGENTS.md`. Scope:
`lineWebhookWorker`, new `visitorIntakeOcrRecovery`, `visitorIntakeAdmin`,
`visitorIntakeReminder`, and the `/myvisitor/` and `/visitors/` static pages.
The workspace has substantial pre-existing changes. Build the release from each
function's current deployed source and apply only the reviewed visitor changes;
do not deploy the entire dirty checkout. Source comparisons earlier in this
session confirmed matching incident handlers, but temporary staging files are
no longer available and must be rebuilt before release.

After release, verify function revisions/scheduler and private browser pages,
then finish the remaining failed-image backfill. Never infer a house assignment
for the unassigned record. The new schedule handles persisted jobs from the new
worker; legacy failures need explicit recovery or queue seeding.
