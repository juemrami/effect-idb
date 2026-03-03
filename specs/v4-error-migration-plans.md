# IndexedDB Error Plan

## Goals

- Keep one ergonomic public top-level error.
- Preserve strong discrimination without forcing consumers to parse operation strings.
- Classify cross-boundary failures predictably.
- Keep strict modeling pressure while avoiding accidental app-wide crashes.

## Public Error Surface

- Top-level exported tag: `IndexedDbError`
- `IndexedDbError.reason` is a tagged domain error:
  - `IndexedDbFactoryError`
  - `IndexedDbMigrationError`
  - `IndexedDbTransactionError`
  - `IndexedDbObjectStoreError`
  - `IndexedDbIndexError`
  - `IndexedDbCursorError`
  - `IndexedDbCodecError`
  - `IndexedDbKeyRangeError`

## Domain / Leaf Model

Each domain error is tagged and contains:
- `reason`: domain leaf tagged error
- `cause`: original error
- `scope`: `open | migration | runtime`
- `phase`: `sync | request`
- `meta`: structured context (`dbName`, `version`, `store`, `index`, `txMode`, `key`, etc)

### IndexedDbFactoryError
Leaf tags:
- `IndexedDbOpenDatabaseError`
- `IndexedDbGetDatabasesError`
- `IndexedDbDeleteDatabaseError`
- `IndexedDbCompareKeysError`
- `IndexedDbBlockedError`

### IndexedDbMigrationError
Leaf tags:
- `IndexedDbCreateObjectStoreError`
- `IndexedDbDeleteObjectStoreError`
- `IndexedDbCreateIndexError`
- `IndexedDbDeleteIndexError`
- `IndexedDbMigrationStepError`

### IndexedDbTransactionError
Leaf tags:
- `IndexedDbOpenTransactionError`
- `IndexedDbAbortTransactionError`
- `IndexedDbGetObjectStoreFromTransactionError`

### IndexedDbObjectStoreError
Leaf tags:
- `IndexedDbObjectStoreAddError`
- `IndexedDbObjectStorePutError`
- `IndexedDbObjectStoreGetError`
- `IndexedDbObjectStoreGetAllError`
- `IndexedDbObjectStoreDeleteError`
- `IndexedDbObjectStoreClearError`
- `IndexedDbGetIndexFromObjectStoreError`

### IndexedDbIndexError
Leaf tags:
- `IndexedDbIndexGetError`
- `IndexedDbIndexGetAllError`
- `IndexedDbIndexGetKeyError`
- `IndexedDbIndexGetAllKeysError`
- `IndexedDbIndexCountError`
- `IndexedDbIndexOpenCursorError`
- `IndexedDbIndexOpenKeyCursorError`

### IndexedDbCursorError
Leaf tags:
- `IndexedDbCursorAdvanceError`
- `IndexedDbCursorContinueError`
- `IndexedDbCursorContinuePrimaryKeyError`
- `IndexedDbCursorUpdateError`
- `IndexedDbCursorDeleteError`

### IndexedDbCodecError
Leaf tags:
- `IndexedDbEncodeError`
- `IndexedDbDecodeError`

### IndexedDbKeyRangeError
Leaf tags:
- `IndexedDbKeyRangeOnlyError`
- `IndexedDbKeyRangeLowerBoundError`
- `IndexedDbKeyRangeUpperBoundError`
- `IndexedDbKeyRangeBoundError`

## Boundary Classification Rules

Classify by method owner (failing boundary), not by target handle type.

- `db.transaction(...)` failure -> `IndexedDbTransactionError`
- `transaction.objectStore(name)` failure -> `IndexedDbTransactionError`
- `objectStore.index(name)` failure -> `IndexedDbObjectStoreError`
- `index.openCursor(...)` / `index.openKeyCursor(...)` failure -> `IndexedDbIndexError`
- after handle acquisition, operations stay in that handle domain:
  - `objectStore.put/get/...` -> `IndexedDbObjectStoreError`
  - `index.get/count/...` -> `IndexedDbIndexError`
  - `cursor.delete/update/...` -> `IndexedDbCursorError`

### Why `transaction.objectStore` stays Transaction

- The API owner that throws is transaction.
- Failure can happen before any object store handle exists.
- This preserves earliest-boundary causality and avoids remapping ambiguity.

Consumer ergonomics can still be improved with helper catch-combinators that group workflow errors without changing canonical tags.

## Unknown Error Policy

### Default (strict)

- Unknown / unmapped boundary errors are defects.
- Domain leaf unions stay clean (no `Unknown*` leaves by default).
- This preserves modeling pressure and prevents lazy catch-all contracts.

### Optional resilience mode

Expose an explicit DB-layer option, for example:
- `unknownBoundaryPolicy: "defect" | "typed"` (default: `"defect"`)

When `"typed"` is selected:
- unknown boundary failures map to one dedicated top-level tag (for example `IndexedDbUnknownBoundaryError`)
- this tag is separate from normal domain-leaf reason unions
- payload includes rich context (`api`, `phase`, `scope`, `cause`, `meta`)

This gives consumers an opt-in catch path for production hardening without making unknowns part of the default public reason taxonomy.

## Mapping from Current Model

Current detailed classes in `src/errors.ts`, with wiring in `src/idbdatabase.ts` and `src/idbobjectstore.ts`, map to:
- one top-level `IndexedDbError`
- one tagged domain layer
- one tagged leaf layer
- shared `scope` / `phase` / `meta` fields

## Verification

- Add type tests asserting:
  - top-level error is `IndexedDbError` (plus optional `IndexedDbUnknownBoundaryError` only when policy is typed)
  - domain narrowing works via `catchReason` on `IndexedDbError.reason`
  - leaf narrowing works via `catchReason` on domain `reason`
- Add runtime tests for boundary classification:
  - missing store in transaction scope
  - missing index on object store
  - cursor open failure paths
- Add policy tests:
  - unknown boundary error defects in strict mode
  - unknown boundary error is catchable in typed mode
