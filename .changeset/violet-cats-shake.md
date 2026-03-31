---
"effect-indexeddb": patch
---

- The `upgradeService.{objectStore|useTransaction}` fields moved into `upgradeService.transaction.use` and `upgradeService.transaction.objectStore` to closer match the native surface IndexedDB API
