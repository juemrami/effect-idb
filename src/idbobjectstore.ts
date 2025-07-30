import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { IDBTransactionService, TransactionRegistryService } from "./idbtransaction.js"

const CONTEXT_PREFIX = "/src/idbobjectstore:"

export type IDBObjectStoreIndexParams =
  | {
    name: string
    keyPath: Array<string>
    options?: {
      /** `keyPath` is an array, so `multiEntry` mu): (new () => Self) & Context.Tag<Self, Effect.Effect.Success<any>> & {
  Config: IDBObjectStoreConfig
  Default: Layer.Layer<Self, any, any>
  WithReadWrite: Layer.Layer<Self, any, any>
  WithReadOnly: Layer.Layer<Self, any, any>
} {false or omitted */
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
export type IDBObjectStoreIndexParams1<T> = {
  name: string
  keyPath: T extends string | Array<string> ? T : never
  options?: {
    /** when `keyPath` is an array `multiEntry` must be false or omitted */
    multiEntry?: T extends Array<string> ? false : boolean
    unique?: boolean
  }
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/add#exceptions
const ObjectStoreAddExceptionType = [
  "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
  "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
  "DataError", // Thrown if: object store uses in-line keys or has key generator and key parameter was provided; object store uses out-of-line keys and has no key generator and no key parameter was provided; object store uses in-line keys but no key generator and the object store's key path does not yield a valid key; key parameter was provided but does not contain a valid key.
  "InvalidStateError", // Thrown if the IDBObjectStore has been deleted or removed.
  "DataCloneError", // Thrown if the data being stored could not be cloned by the internal structured cloning algorithm.
  "ConstraintError" // Thrown if an insert operation failed because the primary key constraint was violated (due to an already existing record with the same primary key value).
] as const
type ObjectStoreAddExceptionType = typeof ObjectStoreAddExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/clear#exceptions
const ObjectStoreClearExceptionType = [
  "InvalidStateError", // Thrown if the object store has been deleted.
  "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
  "TransactionInactiveError" // Thrown if this IDBObjectStore's transaction is inactive.
] as const
type ObjectStoreClearExceptionType = typeof ObjectStoreClearExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/put#exceptions
// NOTE: MDN docs are incomplete - runtime errors from backend are not predictable
const ObjectStorePutSyncExceptionType = [
  "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
  "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
  "DataError", // Thrown if: object store uses in-line keys or has key generator and key parameter was provided; object store uses out-of-line keys and has no key generator and no key parameter was provided; object store uses in-line keys but no key generator and the object store's key path does not yield a valid key; key parameter was provided but does not contain a valid key.
  "InvalidStateError", // Thrown if the IDBObjectStore has been deleted or removed.
  "DataCloneError" // Thrown if the data being stored could not be cloned by the internal structured cloning algorithm.
] as const

// Additional errors that can occur asynchronously (from Chrome source analysis)
const ObjectStorePutAsyncExceptionType = [
  "ConstraintError", // Duplicate key in add(), unique index violation
  "QuotaExceededError", // Storage quota exceeded
  "AbortError", // Transaction was aborted
  "UnknownError" // Backend/storage layer failures
] as const

// Complete set - but you can't predict which category will occur
const ObjectStorePutExceptionType = [
  ...ObjectStorePutSyncExceptionType,
  ...ObjectStorePutAsyncExceptionType
] as const
type ObjectStorePutExceptionType = typeof ObjectStorePutExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/get#exceptions
const ObjectStoreGetExceptionType = [
  "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
  "DataError", // Thrown if key or key range provided contains an invalid key.
  "InvalidStateError" // Thrown if the IDBObjectStore has been deleted or removed.
] as const
type ObjectStoreGetExceptionType = typeof ObjectStoreGetExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAll#exceptions
const ObjectStoreGetAllExceptionType = [
  "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
  "DataError", // Thrown if key or key range provided contains an invalid key or is null.
  "InvalidStateError" // Thrown if the IDBObjectStore has been deleted or removed.
] as const
type ObjectStoreGetAllExceptionType = typeof ObjectStoreGetAllExceptionType[number]
// Note: TypeError is also possible if count parameter is not between 0 and 2^32 - 1 included.

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/delete#exceptions
const ObjectStoreDeleteExceptionType = [
  "TransactionInactiveError", // Thrown if this object store's transaction is inactive.
  "ReadOnlyError", // Thrown if the object store's transaction mode is read-only.
  "InvalidStateError", // Thrown if the object store has been deleted.
  "DataError" // Thrown if key is not a valid key or a key range.
] as const
type ObjectStoreDeleteExceptionType = typeof ObjectStoreDeleteExceptionType[number]

type ObjectStoreOperationExceptionType =
  | ObjectStoreAddExceptionType
  | ObjectStoreClearExceptionType
  | ObjectStorePutExceptionType
  | ObjectStoreGetExceptionType
  | ObjectStoreGetAllExceptionType
  | ObjectStoreDeleteExceptionType

// Note: TypeError is not included as it's not a DOMException but a JavaScript Error type
interface TypedDOMException<T extends ObjectStoreOperationExceptionType = ObjectStoreOperationExceptionType>
  extends DOMException
{
  readonly name: T
}
const isKnownDOMException = <T extends ReadonlyArray<ObjectStoreOperationExceptionType>>(
  error: unknown,
  knownNames: T
): error is TypedDOMException<T[number]> => {
  return error instanceof DOMException && (knownNames as ReadonlyArray<string>).includes(error.name)
}

type ServiceOperations = "add" | "put" | "get" | "getAll" | "delete" | "clear"
export class IDBObjectStoreOperationError extends Data.TaggedError("IDBObjectStoreOperationError")<{
  readonly operation: ServiceOperations
  readonly message: string
  readonly cause: TypeError | TypedDOMException<ObjectStoreOperationExceptionType>
}> {}

const matchObjectStoreError = (
  error: unknown,
  operation: ServiceOperations,
  isAsync: boolean = false
): IDBObjectStoreOperationError | null => {
  const syncText = isAsync ? "Async" : "Sync"
  switch (operation) {
    case "add":
      if (isKnownDOMException(error, ObjectStoreAddExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error adding value to object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStoreAddExceptionType>
        })
      }
      break
    case "clear":
      if (isKnownDOMException(error, ObjectStoreClearExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error clearing object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStoreClearExceptionType>
        })
      }
      break
    case "put":
      if (isKnownDOMException(error, ObjectStorePutExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error putting value in object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStorePutExceptionType>
        })
      }
      break
    case "get":
      if (isKnownDOMException(error, ObjectStoreGetExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error getting value from object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStoreGetExceptionType>
        })
      }
      break
    case "getAll":
      if (isKnownDOMException(error, ObjectStoreGetAllExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error getting all values from object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStoreGetAllExceptionType>
        })
      }
      // Special case: getAll can throw TypeError for invalid count parameter (not a DOMException)
      if (error instanceof TypeError) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error getting all values from object store: ${error.message}`,
          cause: error
        })
      }
      break
    case "delete":
      if (isKnownDOMException(error, ObjectStoreDeleteExceptionType)) {
        return new IDBObjectStoreOperationError({
          operation,
          message: `${syncText} error deleting value from object store: ${error.message}`,
          cause: error as TypedDOMException<ObjectStoreDeleteExceptionType>
        })
      }
      break
  }
  return null
}

/**
 * Wraps an IndexedDB request in an Effect that handles the async completion automatically.
 * This allows for natural chaining of operations without explicit callback handling.
 */
const useRawStoreRequest = <T>(
  objectRequest: () => IDBRequest<T>,
  operation: ServiceOperations
): Effect.Effect<T, IDBObjectStoreOperationError, never> => {
  return Effect.gen(function*() {
    const request = yield* Effect.try({
      try: objectRequest,
      catch: (err) => {
        const matched = matchObjectStoreError(err, operation)
        if (matched === null) throw err // cause defect on unknown errors
        return matched
      }
    })

    return yield* Effect.async<T, IDBObjectStoreOperationError>((resume) => {
      request.onsuccess = (event) => {
        resume(Effect.succeed((event.target as IDBRequest<T>).result))
      }

      request.onerror = (event) => {
        const error = (event.target as IDBRequest<T>).error
        const matched = matchObjectStoreError(error, operation, true)
        if (matched !== null) {
          matched.message = `Async error in IDBRequest for operation "${operation}": ${matched.message}`
          resume(Effect.fail(matched))
        }
        resume(Effect.die("Unknown error in IDBRequest.\n" + error?.message))
      }
    })
  })
}
// used by the transaction service to create a Effect wrappers around the object methods
export const makeObjectStoreProxyService = <T = unknown>(storeName: string) =>
  Effect.gen(function*() {
    const registry = yield* TransactionRegistryService
    yield* registry.addStore(storeName)
    return {
      name: storeName,
      add: <U = T>(value: U, key?: IDBValidKey) =>
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
      put: <U = T>(value: U, key?: IDBValidKey) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest(store.put.bind(store, value, key), "put")
        }),
      get: <U = T>(key: IDBValidKey) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest<U | undefined>(store.get.bind(store, key), "get")
        }),
      getAll: <U = T>(query?: IDBKeyRange, count?: number) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest<Array<U>>(store.getAll.bind(store, query, count), "getAll")
        }),
      delete: (key: IDBValidKey | IDBKeyRange) =>
        Effect.gen(function*() {
          const store = yield* registry.useObjectStore(storeName)
          return yield* useRawStoreRequest(store.delete.bind(store, key), "delete")
          // .pipe(Effect.andThen(() => true)) // Convert void result to boolean
        })
    }
  })

const makeStoreServiceEffect = <T>(config: IDBObjectStoreConfig) => {
  return Effect.gen(function*() {
    const transaction = yield* IDBTransactionService
    const store = yield* transaction.objectStore<T>(config.name)
    // todo: figure out exactly what to expose on this interface
    return {
      config,
      ...store
    }
  })
}

export type IDBObjectStoreConfig = {
  name: string
  params: IDBObjectStoreParameters
  indexes: Array<IDBObjectStoreIndexParams>
}
export class IDBObjectStoreService extends Context.Tag(`${CONTEXT_PREFIX}ObjectStoreService`)<
  IDBObjectStoreService,
  Effect.Effect.Success<ReturnType<typeof makeStoreServiceEffect>>
>() {
  static make = (config: IDBObjectStoreConfig) => Layer.effect(IDBObjectStoreService, makeStoreServiceEffect(config))
}

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
    readonly storeConfig: Config
    readonly makeServiceEffect: (
      baseService: Effect.Effect.Success<ReturnType<typeof makeObjectStoreProxyService<DataShape>>>
    ) => Effect.Effect<Effect.Service.AllowedType<Key, MakeFromArgs<Args>>, any, any>
  },
  const Make extends MakeFromArgs<Args>,
  const LayerWithTransaction extends Layer.Layer<
    Self,
    Effect.Service.MakeError<Make>,
    Exclude<Effect.Service.MakeContext<Make>, IDBTransactionService>
  >
>(key: Key, options: Args) => Effect.Service.Class<Self, Key, Make> & {
  readonly Config: Config
  readonly WithReadWrite: LayerWithTransaction
  readonly WithReadOnly: LayerWithTransaction
  readonly WithFreshReadWrite: LayerWithTransaction
  readonly WithFreshReadOnly: LayerWithTransaction
} = <Self, DataShape>() => (key, options) => {
  const serviceEffect = Effect.gen(function*() {
    const txn = yield* IDBTransactionService
    const baseService = yield* txn.objectStore<DataShape>(options.storeConfig.name)
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
type MakeFromArgs<Args> = Args extends
  { readonly makeServiceEffect: (baseService: any) => Effect.Effect<infer _A, infer _E, infer _R> } ? {
    readonly effect: Effect.Effect<_A, _E, _R | IDBTransactionService>
  } :
  never
