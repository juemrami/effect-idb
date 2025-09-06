import { Data, Match } from "effect"
import type { IndexServiceOperations } from "./idbobjectstore.js"

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
