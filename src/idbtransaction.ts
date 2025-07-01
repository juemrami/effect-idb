import { Context, Data, Effect, Layer, Ref } from "effect"
import { IDBDatabaseService } from "./idbdatabase.js"
import { type IDBObjectStoreIndexParams, makeObjectStoreProxyService } from "./idbobjectstore.js"

export type IDBTransactionConfig = {
  name: string
  options: IDBObjectStoreParameters
  indexes: IDBObjectStoreIndexParams
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
        // console.log("Starting transaction with stores:", storeNames, "and permissions:", mode)
        const nativeTx = yield* dbService.use((db) =>
          Effect.try({
            // https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction#exceptions
            try: () => db.transaction(storeNames, mode),
            catch: (error) => {
              if (isKnownDOMException(error, TransactionOpenExceptionType) || error instanceof TypeError) {
                return new IDBTransactionError({
                  message: `Sync error opening transaction with database.\n${error.message}`,
                  storeNames,
                  mode,
                  cause: error
                })
              }
              // throw new Error(`Unexpected error occurred opening transaction. ${error?.message}`, { cause: error });
              throw error
            }
          })
        )
        yield* Ref.set(liveTransaction, nativeTx)
        return nativeTx
      }),
    useObjectStore: (storeName: string) =>
      Effect.gen(function*() {
        // making some heursitic assumptions here that, but the time this function is called via the proxy methods,
        // the user has finished defining all their object stores for this transaction.
        let nativeTx = yield* Ref.get(liveTransaction)
        if (!nativeTx) {
          nativeTx = yield* service.makeTransaction()
        }
        const mode = yield* Ref.get(permissionRef)
        const storeEffect = Effect.try({
          try: () => nativeTx.objectStore(storeName),
          catch: (error) => {
            if (isKnownDOMException(error, TransactionObjectStoreExceptionType)) {
              return new IDBTransactionError({
                message: `Object store "${storeName}" not found in transaction. \n${error.message}`,
                storeNames: [storeName],
                mode,
                cause: error
              })
            }
            throw error
          }
        })
        return yield* storeEffect
      })
  }
  return service
})

export class TransactionRegistryService extends Context.Tag("TransactionRegistryService")<
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
      objectStore: (storeName: string) =>
        Effect.gen(function*() {
          return yield* makeObjectStoreProxyService(storeName).pipe(
            Effect.provideService(TransactionRegistryService, registry)
          )
        })
    }
  })

export class IDBTransactionService extends Context.Tag("IDBTransactionService")<
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
