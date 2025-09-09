import { Data, Match } from "effect"
import type { IDBDatabaseConfig } from "./idbdatabase.js"
import type { IndexServiceOperations, StoreServiceOperations } from "./idbobjectstore.js"
import type { IDBTransactionParams } from "./idbtransaction.js"

export const isKnownDOMException = <T extends ReadonlyArray<string>>(
  error: unknown,
  knownNames: T
): error is DomException<T[number]> => {
  return error instanceof DOMException && knownNames.includes(error.name)
}
export interface DomException<T extends string> extends DOMException {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/DOMException/name) */
  readonly name: T
}

/*******************************************************************************
 * IDBDatabase Errors
 * includes internal database errors sourcing from async request based operations
 *******************************************************************************/

// https://developer.mozilla.org/en-US/docs/Web/API/IDBRequest/error
export const IDBRequestValidExceptionNames = [
  "AbortError", // All requests still in progress receive this error when the transaction is aborted
  "ConstraintError", // Data doesn't conform to store constraints (e.g., trying to add duplicate key)
  "NotReadableError", // Unrecoverable read failure - record exists in database but value cannot be retrieved
  "QuotaExceededError", // Application runs out of disk quota (browser may prompt user for more space)
  "UnknownError", // Transient read failure errors, including general disk IO and unspecified errors
  "VersionError" // Attempting to open database with version lower than the one it already has
] as const

// https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase#instance_methods
const IDBDatabaseOpValidExceptionNames = {
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/createObjectStore#exceptions
  createObjectStore: [
    "InvalidStateError", // Thrown if not called within an upgrade transaction
    "ConstraintError", // Thrown if an object store with the given name already exists in the connected database
    "InvalidAccessError", // Thrown if autoIncrement is set to true and keyPath is either an empty string or an array
    "SyntaxError", // Thrown if the provided keyPath is not a valid key path, or if the options object is malformed
    "TransactionInactiveError" // Thrown if a request is made on a source database that does not exist, or if the associated upgrade transaction has completed or is processing a request
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/deleteObjectStore#exceptions
  deleteObjectStore: [
    "InvalidStateError", // Thrown if the method was not called from a versionchange transaction callback.
    "TransactionInactiveError", // Thrown if a request is made on a source database that doesn't exist (E.g. has been deleted or removed.)
    "NotFoundError" // Thrown when trying to delete an object store that does not exist.
  ] as const
}

export class IDBDatabaseOpenError extends Data.TaggedError("IDBDatabaseOpenError")<{
  readonly message: string
  readonly config: IDBDatabaseConfig
  /** TypeError if version not a number > zero */
  readonly cause: DomException<typeof IDBRequestValidExceptionNames[number]> | TypeError
}> {
  static fromUnknown(error: unknown, config: IDBDatabaseConfig, isFromRequest: boolean = false) {
    const syncText = isFromRequest ? "Async Request" : "Sync Method"
    if (
      isKnownDOMException(error, IDBRequestValidExceptionNames)
      || error instanceof TypeError
    ) {
      return new IDBDatabaseOpenError({
        message: `${syncText} error opening IndexedDB database. ${error}`,
        config,
        cause: error
      })
    }
    return null
  }
}

export class IDBDatabaseCreateObjectStoreError extends Data.TaggedError("IDBDatabaseCreateObjectStoreError")<{
  readonly message: string
  readonly cause: DomException<typeof IDBDatabaseOpValidExceptionNames["createObjectStore"][number]>
}> {
  static fromUnknown(error: unknown) {
    if (isKnownDOMException(error, IDBDatabaseOpValidExceptionNames.createObjectStore)) {
      return new IDBDatabaseCreateObjectStoreError({
        message: `Sync error creating object store. ${error}`,
        cause: error
      })
    }
    return null
  }
}
export class IDBDatabaseDeleteObjectStoreError extends Data.TaggedError("IDBDatabaseDeleteObjectStoreError")<{
  readonly message: string
  readonly cause?: DomException<typeof IDBDatabaseOpValidExceptionNames["deleteObjectStore"][number]>
}> {
  static fromUnknown(error: unknown) {
    if (isKnownDOMException(error, IDBDatabaseOpValidExceptionNames.deleteObjectStore)) {
      return new IDBDatabaseDeleteObjectStoreError({
        message: `Sync error deleting object store. ${error}`,
        cause: error
      })
    }
    return null
  }
}

/*******************************************************************************
 * IDBTransaction Errors
 *******************************************************************************/

// https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction#exceptions
const TransactionOpenExceptionNames = [
  "InvalidStateError", // Thrown if the close() method has previously been called on this IDBDatabase instance.
  "NotFoundError", // Thrown if an object store specified in the 'storeNames' parameter has been deleted or removed.
  "InvalidAccessError" // Thrown if the function was called with an empty list of store names.
] as const
export class IDBDatabaseTransactionOpenError extends Data.TaggedError("IDBDatabaseTransactionOpenError")<{
  readonly message: string
  readonly params: IDBTransactionParams
  /** TypeError if version not a number > zero */
  readonly cause: DomException<typeof TransactionOpenExceptionNames[number]> | TypeError
}> {
  static fromUnknown(error: unknown, params: IDBTransactionParams) {
    if (
      isKnownDOMException(error, TransactionOpenExceptionNames)
      || error instanceof TypeError
    ) {
      return new IDBDatabaseTransactionOpenError({
        message: `Sync error opening transaction with database. ${error}`,
        params,
        cause: error
      })
    }
    return null
  }
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/abort#exceptions
const IDBTransactionAbortExceptionNames = [
  "InvalidStateError" // Thrown if the transaction has already committed or aborted.
] as const
// note: errors of this type will get swallowed during the upgrade process
export class IDBTransactionAbortError extends Data.TaggedError("IDBTransactionAbortError")<{
  readonly message: string
  readonly params: IDBTransactionParams
  readonly cause: DomException<typeof IDBTransactionAbortExceptionNames[number]>
}> {
  static fromUnknown(error: unknown, params: IDBTransactionParams) {
    if (isKnownDOMException(error, IDBTransactionAbortExceptionNames)) {
      return new IDBTransactionAbortError({
        message: `Sync error aborting transaction. ${error}`,
        params,
        cause: error
      })
    }
    return null
  }
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/objectStore#exceptions
const TransactionObjectStoreExceptionNames = [
  "NotFoundError", // Thrown if the requested object store is not in this transaction's scope.
  "InvalidStateError" // Thrown if the request was made on an object that has been deleted or removed, or if the transaction has finished.
] as const
export class IDBTransactionGetObjectStoreError extends Data.TaggedError("IDBTransactionGetObjectStoreError")<{
  readonly message: string
  params: IDBTransactionParams
  readonly cause: TypeError | DomException<typeof TransactionObjectStoreExceptionNames[number]>
}> {
  static fromUnknown(error: unknown, params: IDBTransactionParams) {
    if (
      isKnownDOMException(error, TransactionObjectStoreExceptionNames)
    ) {
      return new IDBTransactionGetObjectStoreError({
        message: `Sync error getting object store from transaction. ${error}`,
        params,
        cause: error
      })
    }
    return null
  }
}

/*******************************************************************************
 * IDBIndex Errors
 *******************************************************************************/

export const IndexOpValidExceptionNames = {
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/count#exceptions
  count: [
    "TransactionInactiveError", // Thrown if this IDBIndex's transaction is inactive.
    "DataError", // Thrown if the key or key range provided contains an invalid key.
    "InvalidStateError" // Thrown if the IDBIndex has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/get#exceptions
  get: [
    "TransactionInactiveError", // Thrown if this IDBIndex's transaction is inactive.
    "DataError", // Thrown if the key or key range provided contains an invalid key.
    "InvalidStateError" // Thrown if the IDBIndex has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/getKey#exceptions
  getKey: [
    "TransactionInactiveError", // Thrown if this IDBIndex's transaction is inactive.
    "DataError", // Thrown if the key or key range provided contains an invalid key.
    "InvalidStateError" // Thrown if the IDBIndex has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/getAll#exceptions
  // Note: TypeError is also possible if count parameter is not between 0 and 2^32 - 1 included.
  getAll: [
    "TransactionInactiveError", // Thrown if this IDBIndex's transaction is inactive.
    "InvalidStateError" // Thrown if the IDBIndex has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBIndex/getAllKeys#exceptions
  // Note: TypeError is also possible if count parameter is not between 0 and 2^32 - 1 included.
  getAllKeys: [
    "TransactionInactiveError", // Thrown if this IDBIndex's transaction is inactive.
    "InvalidStateError" // Thrown if the IDBIndex has been deleted or removed.
  ] as const
} satisfies Record<IndexServiceOperations, ReadonlyArray<string>>

type OpExceptionNames<Op extends IndexServiceOperations> = typeof IndexOpValidExceptionNames[Op][number]

export type IndexOperationExceptions<
  Op extends IndexServiceOperations
> = Op extends "getAll" ? DomException<OpExceptionNames<Op>> | TypeError
  : Op extends "getAllKeys" ? DomException<OpExceptionNames<Op>> | TypeError
  : DomException<OpExceptionNames<Op>>

type IndexErrorProps<Op extends IndexServiceOperations, IsFromRequest extends boolean> = {
  readonly operation: Op
  readonly message: string
  readonly isFromRequest: IsFromRequest
  readonly cause: IsFromRequest extends true ? DomException<typeof IDBRequestValidExceptionNames[number]>
    : IndexOperationExceptions<Op>
}

/**
 * Attempts to map an unknown error to props for a known IndexedDB Index operation error.
 * @returns `null` if the error is not recognized, otherwise error constructor data.
 */
function indexErrPropsFromUnknown<
  const Op extends IndexServiceOperations,
  const Request extends boolean
>(
  error: unknown,
  operation: Op,
  isFromRequest: Request
) {
  if (
    (!isFromRequest && isKnownDOMException(error, IndexOpValidExceptionNames[operation]))
    || (operation === "getAll" || operation === "getAllKeys") && error instanceof TypeError
    || (isFromRequest && isKnownDOMException(error, IDBRequestValidExceptionNames))
  ) {
    const syncText = isFromRequest ? "Async Request" : "Sync Method"
    const message = Match.type<IndexServiceOperations>().pipe(
      Match.when("get", () => `${syncText} error getting value from index. ${error}`),
      Match.when("getAll", () => `${syncText} error getting all values from index. ${error}`),
      Match.when("getKey", () => `${syncText} error getting key from index. ${error}`),
      Match.when("getAllKeys", () => `${syncText} error getting all keys from index. ${error}`),
      Match.when("count", () => `${syncText} error counting values in index. ${error}`),
      Match.exhaustive
    )(operation)
    return {
      operation,
      message,
      isFromRequest,
      cause: error
    } as IndexErrorProps<Op, Request>
  }
  return null
}

export class IDBIndexGetError<FromRequest extends boolean>
  extends Data.TaggedError("IDBIndexGetError")<IndexErrorProps<"get", FromRequest>>
{}
export class IDBIndexGetAllError<FromRequest extends boolean>
  extends Data.TaggedError("IDBIndexGetAllError")<IndexErrorProps<"getAll", FromRequest>>
{}
export class IDBIndexGetKeyError<FromRequest extends boolean>
  extends Data.TaggedError("IDBIndexGetKeyError")<IndexErrorProps<"getKey", FromRequest>>
{}
export class IDBIndexGetAllKeysError<FromRequest extends boolean>
  extends Data.TaggedError("IDBIndexGetAllKeysError")<IndexErrorProps<"getAllKeys", FromRequest>>
{}
export class IDBIndexCountError<FromRequest extends boolean>
  extends Data.TaggedError("IDBIndexCountError")<IndexErrorProps<"count", FromRequest>>
{}

export type IDBIndexOperationErrorMap<Request extends boolean> = {
  get: IDBIndexGetError<Request>
  getAll: IDBIndexGetAllError<Request>
  getKey: IDBIndexGetKeyError<Request>
  getAllKeys: IDBIndexGetAllKeysError<Request>
  count: IDBIndexCountError<Request>
}

export const IDBIndexOperationErrorMap = {
  fromUnknown<Op extends IndexServiceOperations, const Request extends boolean = false>(
    error: unknown,
    operation: Op,
    isFromRequest: Request = false as Request
  ) {
    const props = indexErrPropsFromUnknown(error, operation, isFromRequest)
    if (!props) return null
    const Err = Match.type<IndexServiceOperations>().pipe(
      Match.when("get", () => IDBIndexGetError),
      Match.when("getAll", () => IDBIndexGetAllError),
      Match.when("getKey", () => IDBIndexGetKeyError),
      Match.when("getAllKeys", () => IDBIndexGetAllKeysError),
      Match.when("count", () => IDBIndexCountError),
      Match.exhaustive
    )(operation)
    // @ts-ignore `operation` should never have a conflicting type here
    return new Err(props) as IDBIndexOperationErrorMap<Request>[Op] | null
  }
}

/*******************************************************************************
 * IDBObjectStore Errors
 *******************************************************************************/

export const StoreOpValidExceptionNames = {
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/add#exceptions
  add: [
    "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
    "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
    "DataError", // Thrown if: object store uses in-line keys or has key generator and key parameter was provided; object store uses out-of-line keys and has no key generator and no key parameter was provided; object store uses in-line keys but no key generator and the object store's key path does not yield a valid key; key parameter was provided but does not contain a valid key.
    "InvalidStateError", // Thrown if the IDBObjectStore has been deleted or removed.
    "DataCloneError", // Thrown if the data being stored could not be cloned by the internal structured cloning algorithm.
    "ConstraintError" // Thrown if an insert operation failed because the primary key constraint was violated (due to an already existing record with the same primary key value).
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/put#exceptions
  // NOTE: MDN docs are incomplete - runtime errors from backend are not predictable
  put: [
    "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
    "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
    "DataError", // Thrown if: object store uses in-line keys or has key generator and key parameter was provided; object store uses out-of-line keys and has no key generator and no key parameter was provided; object store uses in-line keys but no key generator and the object store's key path does not yield a valid key; key parameter was provided but does not contain a valid key.
    "InvalidStateError", // Thrown if the IDBObjectStore has been deleted or removed.
    "DataCloneError" // Thrown if the data being stored could not be cloned by the internal structured cloning algorithm.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/get#exceptions
  get: [
    "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
    "DataError", // Thrown if key or key range provided contains an invalid key.
    "InvalidStateError" // Thrown if the IDBObjectStore has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAll#exceptions
  // Note: TypeError is also possible if count parameter is not between 0 and 2^32 - 1 included.
  getAll: [
    "TransactionInactiveError", // Thrown if this IDBObjectStore's transaction is inactive.
    "DataError", // Thrown if key or key range provided contains an invalid key or is null.
    "InvalidStateError" // Thrown if the IDBObjectStore has been deleted or removed.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/delete#exceptions
  delete: [
    "TransactionInactiveError", // Thrown if this object store's transaction is inactive.
    "ReadOnlyError", // Thrown if the object store's transaction mode is read-only.
    "InvalidStateError", // Thrown if the object store has been deleted.
    "DataError" // Thrown if key is not a valid key or a key range.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/clear#exceptions
  clear: [
    "InvalidStateError", // Thrown if the object store has been deleted.
    "ReadOnlyError", // Thrown if the transaction associated with this operation is in read-only mode.
    "TransactionInactiveError" // Thrown if this IDBObjectStore's transaction is inactive.
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/index#exceptions
  index: [
    "InvalidStateError", // Thrown if the object store has been deleted or transaction is inactive.
    "NotFoundError" // Thrown if the index does not exist (case-sensitive).
  ] as const,
  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/createIndex#exceptions
  createIndex: [
    "ConstraintError", // Thrown if an index with the same name already exists in the database (case-sensitive)
    "InvalidAccessError", // Thrown if the provided key path is a sequence, and multiEntry is set to true in the options
    "InvalidStateError", // Thrown if method was not called from a versionchange transaction mode callback, or if the object store has been deleted
    "SyntaxError", // Thrown if the provided keyPath is not a valid key path
    "TransactionInactiveError" // Thrown if the transaction this IDBObjectStore belongs to is not active (e.g., has been deleted or removed)
  ] as const
} satisfies Record<StoreServiceOperations | "createIndex", ReadonlyArray<string>>

type ValidStoreOperation = keyof typeof StoreOpValidExceptionNames

type StoreOpExceptionNames<Op extends ValidStoreOperation> = typeof StoreOpValidExceptionNames[Op][number]

export type StoreOperationExceptions<
  Op extends ValidStoreOperation
> = Op extends "getAll" ? DomException<StoreOpExceptionNames<Op>> | TypeError
  : DomException<StoreOpExceptionNames<Op>>

type StoreErrorProps<Op extends ValidStoreOperation, IsFromRequest extends boolean = false> = {
  readonly operation: Op
  readonly message: string
  readonly isFromRequest: IsFromRequest
  readonly cause: IsFromRequest extends true ? DomException<typeof IDBRequestValidExceptionNames[number]>
    : StoreOperationExceptions<Op>
}

function storeErrPropsFromUnknown<const Op extends ValidStoreOperation, const Request extends boolean>(
  error: unknown,
  operation: Op,
  isRequest: Request
) {
  const isFromRequest = isRequest === undefined ? false : isRequest
  // todo: better handling for errors sourcing from requests, for now process same as sync method errors.
  if (
    (!isFromRequest && isKnownDOMException(error, StoreOpValidExceptionNames[operation]))
    || (operation === "getAll" && error instanceof TypeError)
    || (isFromRequest && isKnownDOMException(error, IDBRequestValidExceptionNames))
  ) {
    const syncText = isFromRequest ? "Async Request" : "Sync Method"
    const message = Match.type<ValidStoreOperation>().pipe(
      Match.when("add", () => `${syncText} error adding value to object store. ${error}`),
      Match.when("put", () => `${syncText} error putting value in object store. ${error}`),
      Match.when("get", () => `${syncText} error getting value from object store. ${error}`),
      Match.when("getAll", () => `${syncText} error getting all values from object store. ${error}`),
      Match.when("delete", () => `${syncText} error deleting value from object store. ${error}`),
      Match.when("clear", () => `${syncText} error clearing object store. ${error}`),
      Match.when("index", () => `${syncText} error accessing index on object store. ${error}`),
      Match.when("createIndex", () => `${syncText} error creating index on object store. ${error}`),
      Match.exhaustive
    )(operation)
    return {
      operation,
      message,
      isFromRequest,
      cause: error
    } as StoreErrorProps<Op, Request>
  }
  return null
}
export class IDBObjectStoreAddError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStoreAddError")<StoreErrorProps<"add", FromRequest>>
{}
export class IDBObjectStorePutError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStorePutError")<StoreErrorProps<"put", FromRequest>>
{}
export class IDBObjectStoreGetError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStoreGetError")<StoreErrorProps<"get", FromRequest>>
{}
export class IDBObjectStoreGetAllError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStoreGetAllError")<StoreErrorProps<"getAll", FromRequest>>
{}
export class IDBObjectStoreDeleteError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStoreDeleteError")<StoreErrorProps<"delete", FromRequest>>
{}
export class IDBObjectStoreClearError<FromRequest extends boolean>
  extends Data.TaggedClass("IDBObjectStoreClearError")<StoreErrorProps<"clear", FromRequest>>
{}
export class IDBObjectStoreIndexError extends Data.TaggedClass("IDBObjectStoreIndexError")<StoreErrorProps<"index">> {}
// upgradeService operations
export class IDBObjectStoreCreateIndexError
  extends Data.TaggedClass("IDBObjectStoreCreateIndexError")<StoreErrorProps<"createIndex">>
{}

export type IDBObjectStoreOperationErrorMap<Request extends boolean> = {
  add: IDBObjectStoreAddError<Request>
  put: IDBObjectStorePutError<Request>
  get: IDBObjectStoreGetError<Request>
  getAll: IDBObjectStoreGetAllError<Request>
  delete: IDBObjectStoreDeleteError<Request>
  clear: IDBObjectStoreClearError<Request>
  index: IDBObjectStoreIndexError
  createIndex: IDBObjectStoreCreateIndexError
}

export const IDBObjectStoreOperationErrorMap = {
  fromUnknown<Op extends ValidStoreOperation, Request extends boolean = false>(
    error: unknown,
    operation: Op,
    isFromRequest: Request = false as Request
  ) {
    const props = storeErrPropsFromUnknown(error, operation, isFromRequest)
    if (!props) return null
    const Err = Match.type<ValidStoreOperation>().pipe(
      Match.when("add", () => IDBObjectStoreAddError<Request>),
      Match.when("put", () => IDBObjectStorePutError<Request>),
      Match.when("get", () => IDBObjectStoreGetError<Request>),
      Match.when("getAll", () => IDBObjectStoreGetAllError<Request>),
      Match.when("delete", () => IDBObjectStoreDeleteError<Request>),
      Match.when("clear", () => IDBObjectStoreClearError<Request>),
      Match.when("index", () => IDBObjectStoreIndexError),
      Match.when("createIndex", () => IDBObjectStoreCreateIndexError),
      Match.exhaustive
    )(operation)
    // @ts-ignore `operation` should never have a conflicting type here
    return new Err(props) as IDBObjectStoreOperationErrorMap<Request>[Op] | null
  }
}
