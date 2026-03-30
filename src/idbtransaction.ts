import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as ServiceMap from "effect/ServiceMap"
import { IDBDatabaseTransactionOpenError, IDBTransactionGetObjectStoreError } from "./errors.js"
import { IDBDatabaseService } from "./idbdatabase.js"
import type { IDBObjectStoreConfig } from "./idbobjectstore.js"
import { makeObjectStoreProxyService } from "./idbobjectstore.js"

const CONTEXT_PREFIX = "/src/idbtransaction:"

export type IDBTransactionParams = {
  storeNames: Array<string>
  mode: IDBTransactionMode
  options?: IDBTransactionOptions
}

export const getRawTransactionFromRawDatabaseEffect = (
  db: IDBDatabase,
  params: IDBTransactionParams
) => {
  return Effect.try({
    try: () => db.transaction(params.storeNames, params.mode, params.options),
    catch: (error) => {
      const matched = IDBDatabaseTransactionOpenError.fromUnknown(error, params)
      if (matched) return matched
      // defer with original error on unexpected errors
      throw error
    }
  })
}
export const getRawObjectStoreFromRawTransactionEffect = (
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

export class TransactionRegistryService extends ServiceMap.Service<
  TransactionRegistryService
>()(`${CONTEXT_PREFIX}TransactionRegistryService`, {
  make: Effect.gen(function*() {
    const storeNamesRef = yield* Ref.make(new Set<string>())
    const permissionRef = yield* Ref.make<"readonly" | "readwrite">("readonly")
    const liveTransaction = yield* Ref.make<IDBTransaction | null>(null)
    const dbService = yield* IDBDatabaseService
    const service = {
      addStore: (storeName: string) =>
        Effect.gen(function*() {
          const stores = yield* Ref.get(storeNamesRef)
          stores.add(storeName)
        }),
      storeNames: Ref.get(storeNamesRef).pipe(
        Effect.map((stores) => Array.from(stores))
      ),
      setPermissions: (permissions: "readonly" | "readwrite") => Ref.set(permissionRef, permissions),
      makeTransaction: () =>
        Effect.gen(function*() {
          const storeNames = yield* service.storeNames
          const mode = yield* Ref.get(permissionRef)
          const nativeTx = yield* dbService.use((db) =>
            getRawTransactionFromRawDatabaseEffect(db, {
              storeNames,
              mode
            })
          )
          yield* Ref.update(dbService.__transactionHistoryRef, (history) => {
            history.push({ mode, storeNames })
            return history
          })
          yield* Ref.set(liveTransaction, nativeTx)
          return nativeTx
        }),
      useObjectStore: (storeName: string) =>
        Effect.gen(function*() {
          // Requesting an object store will start the transaction if it is not already started:
          // - making some heuristic assumptions here that, by the time this function is called via the proxy methods,
          //   the user has finished defining/registering all the object stores used for this transaction.
          let nativeTx = yield* Ref.get(liveTransaction)
          if (!nativeTx) {
            nativeTx = yield* service.makeTransaction()
          }
          return yield* getRawObjectStoreFromRawTransactionEffect(nativeTx, storeName)
        })
    }
    return service
  })
}) {
  static fresh = Layer.fresh(Layer.effect(this, this.make))
}

export class IDBTransactionService extends ServiceMap.Service<
  IDBTransactionService
>()(`${CONTEXT_PREFIX}TransactionService`, {
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction#instance_methods
  make: Effect.fn(function*(permissions: "readonly" | "readwrite") {
    const registry = yield* TransactionRegistryService
    yield* registry.setPermissions(permissions)
    return {
      use: <A, E, R>(cb: (txn: IDBTransaction) => Effect.Effect<R, E, A>, params?: Partial<IDBTransactionParams>) => {
        return Effect.gen(function*() {
          if (params) {
            const { mode, options, storeNames } = params
            if (storeNames && storeNames.length > 0) {
              yield* Effect.forEach(storeNames, (storeName) => registry.addStore(storeName))
            }
            if (mode) yield* registry.setPermissions(mode as "readonly" | "readwrite")
            if (options) {
              // todo: handle options
            }
          }
          const txn = yield* registry.makeTransaction()
          return yield* cb(txn)
        })
      },
      objectStore: <
        StoreShape = unknown,
        Config extends IDBObjectStoreConfig = IDBObjectStoreConfig
      >(storeName: string) =>
        Effect.gen(function*() {
          return yield* makeObjectStoreProxyService<Config, StoreShape>(storeName).pipe(
            Effect.provideService(TransactionRegistryService, registry)
          )
        })
    }
  })
}) {
  /** Warning: This layer is cacheable by ambient/global effect runtime layer memoMaps. \
   * If you are using this layer you understand the limitations around macrotask boundaries and the idb transaction lifecycle
   */
  static layer = (permissions: "readonly" | "readwrite") =>
    Layer.provide(
      Layer.effect(this, this.make(permissions)),
      TransactionRegistryService.fresh
    )
  static layerFresh = (permissions: "readonly" | "readwrite") => Layer.fresh(this.layer(permissions))
  static ReadWrite = this.layerFresh("readwrite")
  static ReadOnly = this.layerFresh("readonly")
}
