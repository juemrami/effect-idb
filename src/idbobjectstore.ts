import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { IDBIndexOperationErrorMap, IDBObjectStoreOperationErrorMap } from "./errors.js"
import { IDBTransactionService, TransactionRegistryService } from "./idbtransaction.js"

const CONTEXT_PREFIX = "/src/idbobjectstore:"

/*******************************************************************************
 * IndexedDB Index Service
 *******************************************************************************/

export type IndexServiceOperations = "count" | "get" | "getKey" | "getAll" | "getAllKeys"
const useRawIndexRequest = <T, const Op extends IndexServiceOperations>(
  indexRequest: () => IDBRequest<T>,
  operation: Op
) =>
  Effect.gen(function*() {
    const request = yield* Effect.try({
      try: indexRequest,
      catch: (err) => {
        const matched = IDBIndexOperationErrorMap.fromUnknown(err, operation)
        if (matched === null) throw err // cause defect on unknown errors
        else return matched
      }
    })
    return yield* Effect.async<T, IDBIndexOperationErrorMap<true>[Op]>((resume) => {
      request.onsuccess = (event) => {
        resume(Effect.succeed((event.target as IDBRequest<T>).result))
      }
      request.onerror = (event) => {
        const error = (event.target as IDBRequest<T>).error
        const matched = IDBIndexOperationErrorMap.fromUnknown(error, operation, true)
        resume(matched === null ? Effect.die(error) : Effect.fail(matched)) // defect on unknown
      }
    })
  })
// https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex
const makeIndexServiceEffect = <U = unknown>(rawStore: IDBObjectStore, indexName: string) =>
  Effect.gen(function*() {
    const rawIndex = yield* Effect.try({
      try: () => rawStore.index(indexName),
      catch: (err) => {
        const matched = IDBObjectStoreOperationErrorMap.fromUnknown(err, "index")
        if (matched === null) throw err // cause defect on unknown errors
        return matched
      }
    })
    return {
      name: rawIndex.name,
      keyPath: rawIndex.keyPath,
      multiEntry: rawIndex.multiEntry,
      unique: rawIndex.unique,
      get: <T = U>(key: IDBValidKey | IDBKeyRange) =>
        useRawIndexRequest<T | undefined, "get">(
          () => rawIndex.get(key),
          "get"
        ),
      getAll: <T = U>(query?: IDBKeyRange | IDBValidKey, count?: number) =>
        useRawIndexRequest<Array<T>, "getAll">(
          () => rawIndex.getAll(query, count),
          "getAll"
        ),
      count: (key?: IDBValidKey | IDBKeyRange) =>
        useRawIndexRequest<number, "count">(
          () => rawIndex.count(key),
          "count"
        ),
      getKey: (query: IDBValidKey | IDBKeyRange) =>
        useRawIndexRequest(
          () => rawIndex.getKey(query),
          "getKey"
        ),
      getAllKeys: (query?: IDBKeyRange | IDBValidKey, count?: number) =>
        useRawIndexRequest(
          () => rawIndex.getAllKeys(query, count),
          "getAllKeys"
        )
      // todo: openCursor, openKeyCursor
    }
  })
// class IDBIndexService extends Context.Tag(`${CONTEXT_PREFIX}IDBIndexService`)<
//   IDBIndexService,
//   Effect.Effect.Success<ReturnType<typeof makeIndexServiceEffect>>
// >() {
//   static readonly make = makeIndexServiceEffect
// }

/*******************************************************************************
 * IDB Object Store Service
 *******************************************************************************/

export type StoreServiceOperations = "add" | "put" | "get" | "getAll" | "delete" | "clear" | "index"
const useRawStoreRequest = <T, const Op extends StoreServiceOperations>(
  objectRequest: () => IDBRequest<T>,
  operation: Op
) => {
  return Effect.gen(function*() {
    const request = yield* Effect.try({
      try: objectRequest,
      catch: (err) => {
        const matched = IDBObjectStoreOperationErrorMap.fromUnknown(err, operation)
        if (matched === null) throw err // cause defect on unknown errors
        return matched
      }
    })
    return yield* Effect.async<T, IDBObjectStoreOperationErrorMap<true>[Op]>((resume) => {
      request.onsuccess = (event) => {
        resume(Effect.succeed((event.target as IDBRequest<T>).result))
      }
      request.onerror = (event) => {
        const error = (event.target as IDBRequest<T>).error
        const matched = IDBObjectStoreOperationErrorMap.fromUnknown(error, operation, true)
        resume(matched === null ? Effect.die(error) : Effect.fail(matched)) // defect on unknown
      }
    })
  })
}

export interface IDBObjectStoreConfig {
  readonly name: string
  readonly params: IDBObjectStoreParameters
  readonly indexes: Array<IDBObjectStoreIndexParams>
}

export type IDBObjectStoreIndexParams =
  | {
    name: string
    keyPath: Array<string>
    options?: {
      /** `keyPath` is an array, so `multiEntry` must be false or omitted */
      multiEntry?: false
      unique?: boolean
    }
  }
  | {
    name: string
    keyPath: string
    options?: {
      /** `keyPath` is an array, so `multiEntry` must be false or omitted */
      multiEntry?: boolean
      unique?: boolean
    }
  }

type IdxFromConfig<C> = C extends { indexes: ReadonlyArray<infer I> } ? I extends { name: infer N } ? N
  : never
  : never

// used by the transaction service to create a Effect wrappers around the object methods
export const makeObjectStoreProxyService = <
  Config extends { indexes: ReadonlyArray<{ name: string }> },
  StoreShape
>(
  storeName: string
) =>
  Effect.gen(function*() {
    const registry = yield* TransactionRegistryService
    yield* registry.addStore(storeName)
    const useStorePropertyEffect = Effect.fn(function*<const P extends keyof IDBObjectStore>(property: P) {
      const store = yield* registry.useObjectStore(storeName)
      return store[property] as IDBObjectStore[P]
    })
    return {
      // todo: figure out exactly what to expose on this interface
      // The following properties can either be inferred from the config or accessed via the raw object store, but only during a transaction
      // If inferred from config, then they cannot be expected to reflect the state of the store before the upgrade transaction.
      // This could be okay if users are only expected to use the `autoObjectStores` and never interact with upgradeService directly,
      // or the user is expected to not rely on these properties during the upgrade service.
      name: storeName,
      keyPath: useStorePropertyEffect("keyPath"),
      autoIncrement: useStorePropertyEffect("autoIncrement"),
      indexNames: useStorePropertyEffect("indexNames"),
      add: <U = StoreShape>(value: U, key?: IDBValidKey) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          const request = useRawStoreRequest(store.add.bind(store, value, key), "add")
          return yield* request
        }),
      clear: () =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest(store.clear.bind(store), "clear")
        }),
      put: <U = StoreShape>(value: U, key?: IDBValidKey) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest(store.put.bind(store, value, key), "put")
        }),
      get: <U = StoreShape>(key: IDBValidKey) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest<U | undefined, "get">(store.get.bind(store, key), "get")
        }),
      getAll: <U = StoreShape>(query?: IDBKeyRange, count?: number) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest<Array<U>, "getAll">(store.getAll.bind(store, query, count), "getAll")
        }),
      delete: (key: IDBValidKey | IDBKeyRange) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest(store.delete.bind(store, key), "delete")
          // .pipe(Effect.andThen(() => true)) // Convert void result to boolean
        }),
      index: (indexName: IdxFromConfig<Config>) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          const indexService = yield* makeIndexServiceEffect<StoreShape>(store, indexName)
          return indexService
        })
    }
  })

const makeStoreServiceEffect = <
  StoreShape
>(storeName: string) => {
  return Effect.gen(function*() {
    const transaction = yield* IDBTransactionService
    const objectStoreProxy = yield* transaction.objectStore<StoreShape>(storeName)
    return objectStoreProxy
  })
}
export class IDBObjectStoreService extends Context.Tag(`${CONTEXT_PREFIX}ObjectStoreService`)<
  IDBObjectStoreService,
  Effect.Effect.Success<ReturnType<typeof makeStoreServiceEffect>>
>() {
  static make = (storeName: string) => Layer.effect(IDBObjectStoreService, makeStoreServiceEffect(storeName))
}

type MakeFromArgs<Args> = Args extends
  { readonly makeServiceEffect: (baseService: any) => Effect.Effect<infer _A, infer _E, infer _R> } ? {
    readonly effect: Effect.Effect<_A, _E, _R | IDBTransactionService>
  } :
  never

/**
 * Creates a tagged IDB object store service layer with self-contained configuration and extensible methods.
 *
 * This helper generates a service class that encapsulates both the store configuration and custom business logic. \
 * An optional type argument can be provided to specify the shape of objects stored in the IndexedDB store. \
 * The `makeServiceEffect` function receives access to the base service operations (add, get, put, etc.)
 * which can be extended with custom domain-specific methods.
 *
 * @example
 * ```ts
 * class MyContactStore extends TaggedIDBObjectStoreService<MyContactStore, Contact>()(
 *   "MyContactStore",
 *   {
 *     storeConfig: { name: "contacts", params: { keyPath: "id" }, indexes: [] },
 *     makeServiceEffect: (baseService) => Effect.succeed({
 *       ...baseService,
 *       addAsMutuals: (a: Contact, b: Contact) => Effect.gen(function*() {
 *         // Custom business logic using baseService operations
 *         yield* baseService.add(a)
 *         yield* baseService.add(b)
 *       })
 *     })
 *   }
 * ) {}
 * ```
 */
export const TaggedIDBObjectStoreService: <
  Self,
  DataShape = unknown
>() => <
  const Key extends string,
  const Config extends IDBObjectStoreConfig,
  const Args extends {
    readonly makeServiceEffect: (
      baseService: Effect.Effect.Success<ReturnType<typeof makeObjectStoreProxyService<Config, DataShape>>>
    ) => Effect.Effect<Effect.Service.AllowedType<Key, MakeFromArgs<Args>>, any, any>
  },
  const Make extends MakeFromArgs<Args>,
  const LayerWithTransaction extends Layer.Layer<
    Self,
    Effect.Service.MakeError<Make>,
    Exclude<Effect.Service.MakeContext<Make>, IDBTransactionService>
  >
>(
  key: Key,
  options: Args & {
    readonly storeConfig: Config
  }
) => Effect.Service.Class<Self, Key, Make> & {
  readonly Config: Config
  readonly WithReadWrite: LayerWithTransaction
  readonly WithReadOnly: LayerWithTransaction
  readonly WithFreshReadWrite: LayerWithTransaction
  readonly WithFreshReadOnly: LayerWithTransaction
} = <Self, DataShape>() => (key, options) => {
  const serviceEffect = Effect.gen(function*() {
    const txn = yield* IDBTransactionService
    const baseService = yield* txn.objectStore<DataShape, typeof options.storeConfig>(options.storeConfig.name)
    return yield* options.makeServiceEffect(baseService)
  })

  // Create the tag class properly
  // @ts-ignore Effect.Service **is** callable
  let TagClass = Effect.Service<Self>()(key, {
    effect: serviceEffect
  }) as Effect.Service.Class<Self, typeof key, MakeFromArgs<typeof options>>

  // Layer caches. Prevents multiple calls to layer make effect.
  let rwLayerCache, roLayerCache
  TagClass = Object.defineProperties(TagClass, {
    Config: {
      get(this: any) {
        return options.storeConfig
      }
    },
    WithReadWrite: {
      get(this: typeof TagClass) {
        rwLayerCache ??= Layer.provide(this.Default as any, IDBTransactionService.ReadWrite)
        return rwLayerCache
      }
    },
    WithFreshReadWrite: {
      get(this: typeof TagClass) {
        return Layer.fresh(Layer.provide(this.Default as any, IDBTransactionService.ReadWrite))
      }
    },
    WithReadOnly: {
      get(this: typeof TagClass) {
        roLayerCache ??= Layer.provide(this.Default as any, IDBTransactionService.ReadOnly)
        return roLayerCache
      }
    },
    WithFreshReadOnly: {
      get(this: typeof TagClass) {
        return Layer.fresh(Layer.provide(this.Default as any, IDBTransactionService.ReadOnly))
      }
    }
  })
  return TagClass as any
}
