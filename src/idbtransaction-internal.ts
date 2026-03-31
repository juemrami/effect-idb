import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as ServiceMap from "effect/ServiceMap"
import { IDBDatabaseTransactionOpenError, IDBTransactionGetObjectStoreError } from "./errors.js"
import { IDBDatabaseService } from "./idbdatabase.js"

export const safeAcquireIDBObjectStore = (
  transaction: IDBTransaction,
  storeName: string
) =>
  Effect.try({
    try: () => transaction.objectStore(storeName),
    catch: (error) => {
      const matched = IDBTransactionGetObjectStoreError.fromUnknown(error, {
        mode: transaction.mode,
        storeNames: Array.from(transaction.objectStoreNames),
        options: {
          durability: transaction.durability
        }
      })
      if (matched) return matched
      throw error
    }
  })

export class LazyTransactionRegistry extends ServiceMap.Service<LazyTransactionRegistry>()(
  `effect-indexeddb/src/idbtransaction-internal/LazyTransactionRegistry`,
  {
    make: Effect.gen(function*() {
      const db = yield* IDBDatabaseService
      const storeNames = yield* Ref.make(new Set<string>())
      const permission = yield* Ref.make<"readonly" | "readwrite">("readonly")
      const activeIDBTransaction = yield* Ref.make<IDBTransaction | null>(null)
      const service = {
        registerStore: (storeName: string) => Ref.update(storeNames, (names) => names.add(storeName)),
        storeNames: Ref.get(storeNames).pipe(
          Effect.map((stores) => Array.from(stores))
        ),
        setPermissions: (permissions: "readonly" | "readwrite") => Ref.set(permission, permissions),
        /**
         * Safely acquires an `IDBTransaction` from the database w/ the currently registered store names and permissions.\
         */
        acquireTransaction: () =>
          Effect.gen(function*() {
            const storeNames = yield* service.storeNames
            const mode = yield* Ref.get(permission)
            const idbTransaction = yield* db.use((db) =>
              Effect.try({
                try: () => db.transaction(storeNames, mode),
                catch: (error) => {
                  const matched = IDBDatabaseTransactionOpenError.fromUnknown(error, { mode, storeNames })
                  if (matched) return matched
                  // defer with original error on unexpected errors
                  throw error
                }
              })
            )
            yield* Ref.update(db.__transactionHistoryRef, (history) => {
              history.push({ mode, storeNames })
              return history
            })
            yield* Ref.set(activeIDBTransaction, idbTransaction)
            return idbTransaction
          }),
        /**
         * Safely acquires an `IDBObjectStore` from an idb transaction, kick-starting a transaction if one is not already active.\
         *
         * __making some heuristic assumptions here that by the time this function is called, via the proxy methods, \
         * the consuming site has finished defining/registering all the object stores used for this transaction.__
         */
        acquireObjectStore: (storeName: string) =>
          Effect.gen(function*() {
            let idbTransaction = yield* Ref.get(activeIDBTransaction)
            if (!idbTransaction) {
              idbTransaction = yield* service.acquireTransaction()
            }
            return yield* safeAcquireIDBObjectStore(idbTransaction, storeName)
          })
      }
      return service
    })
  }
) {
  static fresh = Layer.fresh(Layer.effect(this, this.make))
}
