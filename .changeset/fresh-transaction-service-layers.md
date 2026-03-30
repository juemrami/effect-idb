---
"effect-indexeddb": patch
---

Refactor `IDBTransactionService.ReadWrite`, and `IDBTransactionService.ReadOnly` to use fresh layers so each provision gets an isolated transaction registry.

This removes memoized sharing across scopes and makes transaction service layers behave consistently for concurrent and nested provisions.

Use `IDBTransactionService.layer` as an escape hatch for a memoMap-ize-able layer
