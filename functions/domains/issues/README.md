# Estate Issues domain

Backs `pattra8.com/report/` — the resident issue / suggestion / feedback channel.

## Entry point

- Export: `estateIssues` (HTTP, POST `{action, ...}`), composed in
  `functions/index.js`.
- Pure contracts: `contracts.js` (no Firestore, no network — unit tested).

## Data ownership

| Collection | Contents |
|---|---|
| `estate_issues` | One document per report: text, attachments, replies, internal notes, status. |
| `estate_issue_counters` | One document per Buddhist-era year holding the ticket sequence. |
| `issues_archive` | Read-only snapshot of the retired `issues` / `private_issues` board. |

Storage prefix: `estate-issues/{issueId}/` (private objects served through
`firebaseStorageDownloadTokens` URLs — never `getSignedUrl`, the gen2 runtime
service account cannot sign).

## Auth policies

| Action group | Policy |
|---|---|
| `submit`, `attach`, `updateIssue`, `removeAttachment`, `myIssues`, `markSeen`, `addComment` | Resident PIN + issue ownership |
| `adminList`, `adminDetail`, `adminReply`, `adminUpdate`, `adminNote`, `adminDelete`, `adminArchive` | Committee permission `admin.issues` |
| `archiveLegacy` | Committee permission `admin.audit` (one-time migration) |

`adminDelete` is the only destructive action: it removes the document and every
attachment object, and writes an `estate_issue_delete` audit entry carrying the
ticket code and title — never the reporter's house number.

## Two invariants

1. **Anonymity.** Login is mandatory, so the house number is always known.
   When `anonymous` is true it must never reach a committee member, including
   the chair. Every admin response goes through `redactIssueForAdmin()`; the
   stored `houseNo` exists only to show the reporter their own thread and to
   rate limit. Never add a field that echoes it back.
2. **LINE containment.** The only permitted push target is the Pattra Watch
   sandbox group (`LINE_FLEX_SANDBOX_TARGET_ID`), hardcoded — not resolved
   through `resolveLineFlexTargetId`, whose `pattraReport` route can be flipped
   to a production group in Firestore config. The notice carries ticket code,
   category, priority and time only.

## Commands

```bash
npm --prefix functions test
npm --prefix functions run lint
```
