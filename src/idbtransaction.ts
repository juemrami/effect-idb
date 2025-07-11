import { Context, Data, Effect, Layer, Ref } from "effect"
import { IDBDatabaseService } from "./idbdatabase.js"
import { makeObjectStoreProxyService } from "./idbobjectstore.js"

const CONTEXT_PREFIX = "/src/idbtransaction:"

export type IDBTransactionParams = {
  storeNames: Array<string>
  mode: IDBTransactionMode
  options?: IDBTransactionOptions
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/objectStore#exceptions
const TransactionObjectStoreExceptionType = [
  "NotFoundError", // Thrown if the requested object store is not in this transaction's scope.
  "InvalidStateError" // Thrown if the request was made on an object that has been deleted or removed, or if the transaction has finished.
] as const
type TransactionObjectStoreExceptionType = typeof TransactionObjectStoreExceptionType[number]
// https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction#exceptions
const TransactionOpenExceptionType = [
  "InvalidStateError", // Thrown if the close() method has previously been called on this IDBDatabase instance.
  "NotFoundError", // Thrown if an object store specified in the 'storeNames' parameter has been deleted or removed.
  "InvalidAccessError" // Thrown if the function was called with an empty list of store names.
] as const
type TransactionOpenExceptionType = typeof TransactionOpenExceptionType[number]
type TransactionExceptionType = TransactionObjectStoreExceptionType | TransactionOpenExceptionType
interface TypedDOMException<T extends TransactionExceptionType = TransactionExceptionType> extends DOMException {
  readonly name: T
}
const isKnownDOMException = <T extends ReadonlyArray<TransactionExceptionType>>(
  error: unknown,
  knownNames: T
): error is TypedDOMException<T[number]> => {
  return error instanceof DOMException && (knownNames as ReadonlyArray<string>).includes(error.name)
}
export class IDBTransactionError extends Data.TaggedError("IDBTransactionError")<{
  readonly message: string
  readonly storeNames?: Array<string>
  readonly mode?: IDBTransactionMode
  readonly options?: IDBTransactionOptions
  readonly cause: TypeError | TypedDOMException<TransactionOpenExceptionType | TransactionObjectStoreExceptionType>
}> {}

export const getRawTransactionFromRawDatabaseEffect = (
  db: IDBDatabase,
  params: IDBTransactionParams
) => {
  return Effect.try({
    // https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction#exceptions
    try: () => db.transaction(params.storeNames, params.mode, params.options),
    catch: (error) => {
      if (isKnownDOMException(error, TransactionOpenExceptionType) || error instanceof TypeError) {
        return new IDBTransactionError({
          message: `Sync error opening transaction with database.\n${error.message}`,
          storeNames: params.storeNames,
          mode: params.mode,
          cause: error
        })
      }
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
      if (isKnownDOMException(error, TransactionObjectStoreExceptionType)) {
        return new IDBTransactionError({
          message: `Object store "${storeName}" not found in transaction. \n${error.message}`,
          storeNames: [storeName],
          mode: transaction.mode,
          cause: error
        })
      }
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
      Ref.get(storeNamesRef).pipe(
        Effect.tap((stores) => stores.add(storeName))
      ),
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

export class TransactionRegistryService extends Context.Tag(`${CONTEXT_PREFIX}TransactionRegistryService`)<
  TransactionRegistryService,
  Effect.Effect.Success<typeof registryServiceEffect>
>() {
  private static serviceEffect = registryServiceEffect
  static Live = Layer.effect(TransactionRegistryService, this.serviceEffect)
}

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
      objectStore: <T>(storeName: string) =>
        Effect.gen(function*() {
          return yield* makeObjectStoreProxyService<T>(storeName).pipe(
            Effect.provideService(TransactionRegistryService, registry)
          )
        })
    }
  })

export class IDBTransactionService extends Context.Tag(`${CONTEXT_PREFIX}TransactionService`)<
  IDBTransactionService,
  Effect.Effect.Success<ReturnType<typeof makeTransactionService>>
>() {
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
