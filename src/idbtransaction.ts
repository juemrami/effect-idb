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
const registryServiceEffect = Effect.gen(function*() {
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

export class TransactionRegistryService extends ServiceMap.Service<
  TransactionRegistryService,
  Effect.Success<typeof registryServiceEffect>
>()(`${CONTEXT_PREFIX}TransactionRegistryService`) {
  private static makeEffect = registryServiceEffect
  static Live = Layer.effect(TransactionRegistryService, this.makeEffect)
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction#instance_methods
const makeTransactionService = (permissions: "readonly" | "readwrite") =>
  Effect.gen(function*() {
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

export class IDBTransactionService extends ServiceMap.Service<
  IDBTransactionService,
  Effect.Success<ReturnType<typeof makeTransactionService>>
>()(`${CONTEXT_PREFIX}TransactionService`) {
  private static make = (permissions: "readonly" | "readwrite") => {
    return Layer.effect(IDBTransactionService, makeTransactionService(permissions)).pipe(
      Layer.provide(TransactionRegistryService.Live)
    )
  }
  // may need fresh layers for scope isolation and parallel transactions
  // private static _makeFresh: typeof this.make = (perms) => Layer.fresh(this.make(perms))
  static ReadWrite = this.make("readwrite")
  static ReadOnly = this.make("readonly")
}
