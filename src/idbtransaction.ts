import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"
import type { IDBObjectStoreConfig } from "./idbobjectstore.js"
import { makeObjectStoreProxyService } from "./idbobjectstore.js"
import { LazyTransactionRegistry } from "./idbtransaction-internal.js"

const CONTEXT_PREFIX = "/src/idbtransaction:"

export type IDBTransactionParams = {
  storeNames: Array<string>
  mode: IDBTransactionMode
  options?: IDBTransactionOptions
}

export class IDBTransactionService extends ServiceMap.Service<
  IDBTransactionService
>()(`${CONTEXT_PREFIX}TransactionService`, {
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction#instance_methods
  make: Effect.fn(function*(permissions: "readonly" | "readwrite") {
    const registry = yield* LazyTransactionRegistry
    yield* registry.setPermissions(permissions)
    return {
      use: <A, E, R>(cb: (txn: IDBTransaction) => Effect.Effect<R, E, A>, params?: Partial<IDBTransactionParams>) => {
        return Effect.gen(function*() {
          if (params) {
            const { mode, options, storeNames } = params
            if (storeNames && storeNames.length > 0) {
              yield* Effect.forEach(storeNames, (storeName) => registry.registerStore(storeName))
            }
            if (mode) yield* registry.setPermissions(mode as "readonly" | "readwrite")
            if (options) {
              // todo: handle options
            }
          }
          const txn = yield* registry.acquireTransaction()
          return yield* cb(txn)
        })
      },
      objectStore: <
        StoreShape = unknown,
        Config extends IDBObjectStoreConfig = IDBObjectStoreConfig
      >(storeName: string) =>
        Effect.gen(function*() {
          return yield* makeObjectStoreProxyService<Config, StoreShape>(storeName).pipe(
            Effect.provideService(LazyTransactionRegistry, registry)
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
      LazyTransactionRegistry.fresh
    )
  static layerFresh = (permissions: "readonly" | "readwrite") => Layer.fresh(this.layer(permissions))
  static ReadWrite = this.layerFresh("readwrite")
  static ReadOnly = this.layerFresh("readonly")
}
