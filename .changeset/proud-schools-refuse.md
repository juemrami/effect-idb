---
"effect-indexeddb": patch
---

Some static layers provided by `TaggedIDBObjectStoreService`, namely `.WithReadOnly`, `.WithReadWrite` now provideMerge `IDBTransactionService`.

Allows the transaction layer to be provided to other ObjectStore layers within the same program.
