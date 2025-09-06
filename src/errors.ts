import { Data, Match } from "effect"
import type { IndexServiceOperations, StoreServiceOperations } from "./idbobjectstore.js"

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

type ErrorProps<Op extends IndexServiceOperations> = {
  readonly operation: Op
  readonly message: string
  readonly cause: IndexOperationExceptions<Op>
}

/**
 * Attempts to map an unknown error to props for a known IndexedDB Index operation error.
 * @returns `null` if the error is not recognized, otherwise error constructor data.
 */
function errPropsFromUnknown<const Op extends IndexServiceOperations>(
  error: unknown,
  operation: Op,
  isFromRequest: boolean = false
): ErrorProps<Op> | null {
  // todo: better handling for errors sourcing from requests, for now process same as sync method errors.
  if (
    (isKnownDOMException(error, IndexOpValidExceptionNames[operation]))
    || (operation === "getAll" || operation === "getAllKeys") && error instanceof TypeError
  ) {
    const syncText = isFromRequest ? "Async Request " : "Sync Method"
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
      cause: error as IndexOperationExceptions<Op>
    }
  }
  return null
}

const TaggedIndexError =
  <Self>() =>
  <const Op extends IndexServiceOperations, const Tag extends string>({ operation, tag }: {
    tag: Tag
    operation: Op
  }) => {
    const ErrClass = Data.TaggedError(tag)
    Object.defineProperty(ErrClass, "fromUnknown", {
      get(this) {
        return (error: unknown, isFromRequest: boolean = false) => {
          const props = errPropsFromUnknown(error, operation, isFromRequest)
          if (props) return new ErrClass<ErrorProps<Op>>(props) as Self
          return null
        }
      }
    })
    return ErrClass as unknown as typeof ErrClass<ErrorProps<Op>> & {
      readonly fromUnknown: (
        error: unknown,
        isFromRequest?: boolean
      ) => Self | null
    }
  }

export class IDBIndexGetError extends TaggedIndexError<IDBIndexGetError>()({
  tag: "IDBIndexGetError",
  operation: "get"
}) {}
export class IDBIndexGetAllError extends TaggedIndexError<IDBIndexGetAllError>()({
  tag: "IDBIndexGetAllError",
  operation: "getAll"
}) {}
export class IDBIndexGetKeyError extends TaggedIndexError<IDBIndexGetKeyError>()({
  tag: "IDBIndexGetKeyError",
  operation: "getKey"
}) {}
export class IDBIndexGetAllKeysError extends TaggedIndexError<IDBIndexGetAllKeysError>()({
  tag: "IDBIndexGetAllKeysError",
  operation: "getAllKeys"
}) {}
export class IDBIndexCountError extends TaggedIndexError<IDBIndexCountError>()({
  tag: "IDBIndexCountError",
  operation: "count"
}) {}

export type IDBIndexOperationErrorMap = {
  get: IDBIndexGetError
  getAll: IDBIndexGetAllError
  getKey: IDBIndexGetKeyError
  getAllKeys: IDBIndexGetAllKeysError
  count: IDBIndexCountError
}

export const IDBIndexOperationErrorMap = {
  fromUnknown<Op extends IndexServiceOperations>(
    error: unknown,
    operation: Op,
    isFromRequest: boolean = false
  ) {
    const Err = Match.type<IndexServiceOperations>().pipe(
      Match.when("get", () => IDBIndexGetError),
      Match.when("getAll", () => IDBIndexGetAllError),
      Match.when("getKey", () => IDBIndexGetKeyError),
      Match.when("getAllKeys", () => IDBIndexGetAllKeysError),
      Match.when("count", () => IDBIndexCountError),
      Match.exhaustive
    )(operation)
    return Err.fromUnknown(error, isFromRequest) as IDBIndexOperationErrorMap[Op] | null
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
  ] as const
} satisfies Record<StoreServiceOperations, ReadonlyArray<string>>

type StoreOpExceptionNames<Op extends StoreServiceOperations> = typeof StoreOpValidExceptionNames[Op][number]
export type StoreOperationExceptions<
  Op extends StoreServiceOperations
> = Op extends "getAll" ? DomException<StoreOpExceptionNames<Op>> | TypeError
  : DomException<StoreOpExceptionNames<Op>>

type StoreErrorProps<Op extends StoreServiceOperations> = {
  readonly operation: Op
  readonly message: string
  readonly cause: StoreOperationExceptions<Op>
}

function storeErrPropsFromUnknown<const Op extends StoreServiceOperations>(
  error: unknown,
  operation: Op,
  isFromRequest: boolean = false
): StoreErrorProps<Op> | null {
  // todo: better handling for errors sourcing from requests, for now process same as sync method errors.
  if (
    (isKnownDOMException(error, StoreOpValidExceptionNames[operation]))
    || (operation === "getAll" && error instanceof TypeError)
  ) {
    const syncText = isFromRequest ? "Async Request" : "Sync Method"
    const message = Match.type<StoreServiceOperations>().pipe(
      Match.when("add", () => `${syncText} error adding value to object store. ${error}`),
      Match.when("put", () => `${syncText} error putting value in object store. ${error}`),
      Match.when("get", () => `${syncText} error getting value from object store. ${error}`),
      Match.when("getAll", () => `${syncText} error getting all values from object store. ${error}`),
      Match.when("delete", () => `${syncText} error deleting value from object store. ${error}`),
      Match.when("clear", () => `${syncText} error clearing object store. ${error}`),
      Match.when("index", () => `${syncText} error accessing index on object store. ${error}`),
      Match.exhaustive
    )(operation)
    return {
      operation,
      message,
      cause: error as StoreOperationExceptions<Op>
    }
  }
  return null
}

const TaggedStoreError =
  <Self>() =>
  <const Op extends StoreServiceOperations, const Tag extends string>({ operation, tag }: {
    tag: Tag
    operation: Op
  }) => {
    const ErrClass = Data.TaggedError(tag)
    Object.defineProperty(ErrClass, "fromUnknown", {
      get(this) {
        return (error: unknown, isFromRequest: boolean = false) => {
          const props = storeErrPropsFromUnknown(error, operation, isFromRequest)
          if (props) return new ErrClass<StoreErrorProps<Op>>(props) as Self
          return null
        }
      }
    })
    return ErrClass as unknown as typeof ErrClass<StoreErrorProps<Op>> & {
      readonly fromUnknown: (
        error: unknown,
        isFromRequest?: boolean
      ) => Self | null
    }
  }

export class IDBObjectStoreAddError extends TaggedStoreError<IDBObjectStoreAddError>()({
  tag: "IDBObjectStoreAddError",
  operation: "add"
}) {}
export class IDBObjectStorePutError extends TaggedStoreError<IDBObjectStorePutError>()({
  tag: "IDBObjectStorePutError",
  operation: "put"
}) {}
export class IDBObjectStoreGetError extends TaggedStoreError<IDBObjectStoreGetError>()({
  tag: "IDBObjectStoreGetError",
  operation: "get"
}) {}
export class IDBObjectStoreGetAllError extends TaggedStoreError<IDBObjectStoreGetAllError>()({
  tag: "IDBObjectStoreGetAllError",
  operation: "getAll"
}) {}
export class IDBObjectStoreDeleteError extends TaggedStoreError<IDBObjectStoreDeleteError>()({
  tag: "IDBObjectStoreDeleteError",
  operation: "delete"
}) {}
export class IDBObjectStoreClearError extends TaggedStoreError<IDBObjectStoreClearError>()({
  tag: "IDBObjectStoreClearError",
  operation: "clear"
}) {}
export class IDBObjectStoreIndexError extends TaggedStoreError<IDBObjectStoreIndexError>()({
  tag: "IDBObjectStoreIndexError",
  operation: "index"
}) {}

export type IDBObjectStoreOperationErrorMap = {
  add: IDBObjectStoreAddError
  put: IDBObjectStorePutError
  get: IDBObjectStoreGetError
  getAll: IDBObjectStoreGetAllError
  delete: IDBObjectStoreDeleteError
  clear: IDBObjectStoreClearError
  index: IDBObjectStoreIndexError
}

export const IDBObjectStoreOperationErrorMap = {
  fromUnknown<Op extends StoreServiceOperations>(
    error: unknown,
    operation: Op,
    isFromRequest: boolean = false
  ) {
    const Err = Match.type<StoreServiceOperations>().pipe(
      Match.when("add", () => IDBObjectStoreAddError),
      Match.when("put", () => IDBObjectStorePutError),
      Match.when("get", () => IDBObjectStoreGetError),
      Match.when("getAll", () => IDBObjectStoreGetAllError),
      Match.when("delete", () => IDBObjectStoreDeleteError),
      Match.when("clear", () => IDBObjectStoreClearError),
      Match.when("index", () => IDBObjectStoreIndexError),
      Match.exhaustive
    )(operation)
    return Err.fromUnknown(error, isFromRequest) as IDBObjectStoreOperationErrorMap[Op] | null
  }
}
