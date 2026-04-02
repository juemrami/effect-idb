# effect-indexeddb

## 1.0.0-beta.4

### Patch Changes

- 6db974d: `TaggedIDBObjectStoreService` layer helpers now create fresh transaction layers by default.

  `WithReadOnly` and `WithReadWrite` no longer share cached transactions across provisions, which avoids reusing the same transaction in concurrent or nested effects. The non-transaction base layer is now exposed as `layerNoTransaction`, and the old `Default` accessor is deprecated in favor of it.

  If you were wrapping these helpers in `Layer.fresh`, you can remove that extra wrapping. If you only need the base object-store layer without providing a transaction service, switch from `Default` to `layerNoTransaction`.

- 1372443: Refactor `IDBTransactionService.ReadWrite`, and `IDBTransactionService.ReadOnly` to use fresh layers so each provision gets an isolated transaction registry.

  This removes memoized sharing across scopes and makes transaction service layers behave consistently for concurrent and nested provisions.

  Use `IDBTransactionService.layer` as an escape hatch for a memoMap-ize-able layer

- 59aace3: Some static layers provided by `TaggedIDBObjectStoreService`, namely `.WithReadOnly`, `.WithReadWrite` now provideMerge `IDBTransactionService`.

  Allows the transaction layer to be provided to other ObjectStore layers within the same program.

- eda720d: IDBDatabaseService surface API renames: - `IDBDatabaseService.makeTest` -> `IDBDatabaseService.layer` - `IDBDatabaseService.Live` -> `IDBDatabaseService.layerBrowser`
- 5ad7804: - The `upgradeService.{objectStore|useTransaction}` fields moved into `upgradeService.transaction.use` and `upgradeService.transaction.objectStore` to closer match the native surface IndexedDB API
- 4f056f8: adds `.databases` and `deleteDatabase` methods to `IDBFactoryService`
