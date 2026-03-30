---
"effect-indexeddb": patch
---

`TaggedIDBObjectStoreService` layer helpers now create fresh transaction layers by default.

`WithReadOnly` and `WithReadWrite` no longer share cached transactions across provisions, which avoids reusing the same transaction in concurrent or nested effects. The non-transaction base layer is now exposed as `layerNoTransaction`, and the old `Default` accessor is deprecated in favor of it.

If you were wrapping these helpers in `Layer.fresh`, you can remove that extra wrapping. If you only need the base object-store layer without providing a transaction service, switch from `Default` to `layerNoTransaction`.
