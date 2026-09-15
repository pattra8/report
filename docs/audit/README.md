# Pattra Report system audit

This directory is the evidence-backed navigation layer for the current system.
It is intentionally written before implementation refactoring so that humans and
AI agents can locate a feature, its entry point, and its data dependencies
without scanning the 12,000+ line `functions/index.js` first.

## Start here

1. [`current-architecture.md`](current-architecture.md) — runtime boundaries and
   the current request/data flow.
2. [`function-inventory.md`](function-inventory.md) — every deployed export,
   grouped by domain and trigger type.
3. [`firestore-data-model.md`](firestore-data-model.md) — collection ownership,
   writers/readers, and query review priorities.
4. [`external-integrations.md`](external-integrations.md) — integration ownership
   and failure boundaries.
5. [`api-conventions.md`](api-conventions.md) — compatibility and target HTTP,
   auth, validation, and error rules.
6. [`feature-alignment.md`](feature-alignment.md) — website page to backend/data
   alignment and caller gaps.
7. [`workspace-callers.md`](workspace-callers.md) — callers found across sibling
   Pattra projects.
8. [`findings.md`](findings.md) — verified baseline findings and evidence.
9. [`target-architecture.md`](target-architecture.md) — proposed module layout,
   conventions, migration gates, and rollback strategy.

## Evidence boundary

The function inventory's caller column covers the Git repository rooted at
`Pattra Report/`; `workspace-callers.md` adds a wider static scan. A function
still marked **caller not found** may be used by another Pattra subproject, LINE,
scheduled infrastructure, the LPR appliance, or an unpublished admin client. It
does not mean the function is unused. Confirm production callers and logs before
renaming or removing any export.

## Non-negotiable change rules

- Keep exported Firebase function names stable during modularization.
- Do not deploy from an architecture/refactor task without explicit approval.
- Do not use production resident data as a test fixture.
- Add contract tests before moving a handler.
- Preserve Bangkok timezone behavior for every scheduled/reporting workflow.
- Treat authorization and data-integrity checks as behavior, not cleanup.
