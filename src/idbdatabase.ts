import { Context, Data, Effect, Fiber, Layer, pipe } from "effect"
import { indexedDB as testIndexedDB } from "fake-indexeddb"
import type { IDBObjectStoreConfig, IDBObjectStoreIndexParams } from "./idbobjectstore.js"

export class IDBFactoryImplementation extends Context.Tag("IDBFactory")<IDBFactoryImplementation, IDBFactory>() {
  static readonly live = Layer.sync(IDBFactoryImplementation, () => window.indexedDB)
  // use for testing outside of the browser environment
  static readonly test = Layer.succeed(IDBFactoryImplementation, testIndexedDB)
}

// https://developer.mozilla.org/en-US/docs/Web/API/IDBRequest/error
const IDBRequestExceptionType = [
  "AbortError", // All requests still in progress receive this error when the transaction is aborted
  "ConstraintError", // Data doesn't conform to store constraints (e.g., trying to add duplicate key)
  "NotReadableError", // Unrecoverable read failure - record exists in database but value cannot be retrieved
  "QuotaExceededError", // Application runs out of disk quota (browser may prompt user for more space)
  "UnknownError", // Transient read failure errors, including general disk IO and unspecified errors
  "VersionError" // Attempting to open database with version lower than the one it already has
] as const
type IDBRequestExceptionType = typeof IDBRequestExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/createObjectStore#exceptions
const CreateObjectStoreExceptionType = [
  "InvalidStateError", // Thrown if not called within an upgrade transaction
  "ConstraintError", // Thrown if an object store with the given name already exists in the connected database
  "InvalidAccessError", // Thrown if autoIncrement is set to true and keyPath is either an empty string or an array
  "SyntaxError", // Thrown if the provided keyPath is not a valid key path, or if the options object is malformed
  "TransactionInactiveError" // Thrown if a request is made on a source database that does not exist, or if the associated upgrade transaction has completed or is processing a request
] as const
type CreateObjectStoreExceptionType = typeof CreateObjectStoreExceptionType[number]

// https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/createIndex#exceptions
const CreateObjectStoreIndexExceptionType = [
  "ConstraintError", // Thrown if an index with the same name already exists in the database (case-sensitive)
  "InvalidAccessError", // Thrown if the provided key path is a sequence, and multiEntry is set to true in the options
  "InvalidStateError", // Thrown if method was not called from a versionchange transaction mode callback, or if the object store has been deleted
  "SyntaxError", // Thrown if the provided keyPath is not a valid key path
  "TransactionInactiveError" // Thrown if the transaction this IDBObjectStore belongs to is not active (e.g., has been deleted or removed)
] as const
type CreateObjectStoreIndexExceptionType = typeof CreateObjectStoreIndexExceptionType[number]

type ExpectedExceptionType =
  | IDBRequestExceptionType
  | CreateObjectStoreExceptionType
  | CreateObjectStoreIndexExceptionType
interface TypedDOMException<T extends ExpectedExceptionType = ExpectedExceptionType> extends DOMException {
  readonly name: T
}
const isKnownDOMException = <T extends ReadonlyArray<ExpectedExceptionType>>(
  error: unknown,
  knownNames: T
): error is TypedDOMException<T[number]> => {
  return error instanceof DOMException && (knownNames as ReadonlyArray<string>).includes(error.name)
}
export class IDBDatabaseOpenError extends Data.TaggedError("IDBDatabaseOpenError")<{
  readonly message: string
  readonly config?: IDBDatabaseConfig
  readonly cause?: TypedDOMException | TypeError
}> {}
export class IDBDatabaseObjectStoreCreationError extends Data.TaggedError("IDBDatabaseObjectStoreCreationError")<{
  readonly message: string
  readonly storeName: string
  readonly cause: TypedDOMException<CreateObjectStoreExceptionType | CreateObjectStoreIndexExceptionType>
}> {}
export class IDBDatabaseObjectStoreDeletionError extends Data.TaggedError("IDBDatabaseObjectStoreDeletionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const createBaseService = (db: IDBDatabase) => {
  // handle to raw db connection
  const use = <A, E, R>(cb: (db: IDBDatabase) => Effect.Effect<A, E, R>) =>
    Effect.gen(function*() {
      return yield* cb(db)
    })
  return {
    name: db.name,
    version: db.version,
    objectStoreNames: Effect.sync(() => Array.from(db.objectStoreNames) as Array<string>),
    use
  }
}
type DBServiceShape = ReturnType<typeof createBaseService>
const createUpgradeService = (db: IDBDatabase, config: IDBDatabaseConfig) => {
  const baseService = createBaseService(db)
    const createObjectStore = (
    name: string,
    options?: IDBObjectStoreParameters,
    indexes: Array<IDBObjectStoreIndexParams> = []
  ) =>
    pipe(
      // call native db create function and get the store reference
      Effect.try({
        try: () => db.createObjectStore(name, options),
        catch: (error) => {
          if (isKnownDOMException(error, CreateObjectStoreExceptionType)) {
            return new IDBDatabaseObjectStoreCreationError({
              message: `Sync error creating objectStore "${name}".\n${error.message}`,
              storeName: name,
              cause: error
            })
          } else throw new Error(`Unexpected error creating object store ${name}`, { cause: error })
        }
      }),
      // create any specified indexes on the store
      Effect.tap((store) =>
        Effect.forEach(indexes, (index) =>
          Effect.try({
            try: () => store.createIndex(index.name, index.keyPath, index.options),
            catch: (error) => {
              if (isKnownDOMException(error, CreateObjectStoreIndexExceptionType)) {
                return new IDBDatabaseObjectStoreCreationError({
                  message: `Sync error creating index "${index.name}" on object store`,
                  storeName: store.name,
                  cause: error
                })
              } else throw new Error(`Unexpected error creating index "${index.name}"`, { cause: error })
            }
          }))
      )
    )
  const deleteObjectStore = (name: string) => {
    return pipe(Effect.try({
      try: () => db.deleteObjectStore(name),
      catch: (error) =>
        new IDBDatabaseObjectStoreDeletionError({
          message: `Sync error deleting object store ${name}`,
          cause: error
        })
    }))
  }
  return {
    ...baseService,
    createObjectStore,
    deleteObjectStore,
    autoGenerateObjectStores: Effect.gen(function*() {
      // Create all object stores if they don't exist
      yield* Effect.forEach(config.objectStores ?? [], (storeConfig) =>
        Effect.gen(function*() {
          // check if store already exists
          if (db.objectStoreNames.contains(storeConfig.name)) return
          // create the store and any indexes
          yield* createObjectStore(
            storeConfig.name,
            storeConfig.params,
            storeConfig.indexes ?? []
          )
        }))
    })
  }
}
export type IDBDatabaseConfig = {
  name: string
  version?: number // defaults to `1` if db doesnt already exist
  objectStores?: Array<IDBObjectStoreConfig>
  onUpgrade?: (db: ReturnType<typeof createUpgradeService>) => Record<number, Effect.Effect<any, any, never>>
}
export class IDBDatabaseService extends Context.Tag("IDBDatabaseService")<IDBDatabaseService, DBServiceShape>() {
  static make = (config: IDBDatabaseConfig) =>
    Layer.scoped(
      IDBDatabaseService,
      Effect.gen(function*() {
        const dbFactory = yield* IDBFactoryService
        const db = yield* Effect.acquireRelease(
          dbFactory.open(config),
          /**
           * `close` is automatically handled by the browser on page unload
           * only times you'd want to explicitly close is when we want to because of:
           * - new database version opened on another tab
           * - or before db version upgrades
           * - or db deletions (new db connections cant upgrade till old ones are closed)
          */
         (db) =>
            Effect.sync(() => {
              // console.log("closing db connection", db.name)
              db.close()
            })
        )
        // console.log("creating db service", config)
        return createBaseService(db)
      })
    )
  static makeLive = (config: IDBDatabaseConfig) =>
    Layer.provide(
      IDBDatabaseService.make(config),
      IDBFactoryService.Live
    )
  static makeTest = (config: IDBDatabaseConfig) =>
    Layer.provide(
      IDBDatabaseService.make(config),
      IDBFactoryService.Test
    )
}
// unsure if this wrapper is needed or just makes this more complex.
export class IDBFactoryService extends Context.Tag("IDBFactoryService")<
  IDBFactoryService,
  {
    open: (config: IDBDatabaseConfig) => Effect.Effect<IDBDatabase, IDBDatabaseOpenError>
    // close: (name: string) => Effect.Effect<void, Error>;
    // isOpen: (name: string) => Effect.Effect<boolean, Error>;
  }
>() {
  static DefaultNoDependencies = Layer.effect(
    IDBFactoryService,
    Effect.gen(function*() {
      const indexedDB = yield* IDBFactoryImplementation
      return {
        open: (config: IDBDatabaseConfig) =>
          Effect.gen(function*() {
            const request = yield* Effect.try({
              try: () => indexedDB.open(config.name, config.version),
              // https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open#exceptions
              catch: (error) => {
                if (error instanceof TypeError) {
                  return new IDBDatabaseOpenError({
                    message: `Sync Error opening connection.\n${error.message}`,
                    config,
                    cause: error
                  })
                }
                throw new Error(`Unexpected Error Opening db connection. ${error}`, { cause: error }) // defect with original error
              }
            })
            const dbConnection = yield* Effect.async<IDBDatabase, IDBDatabaseOpenError>((resume, _signal) => {
              // Read to understand possible order of these event cbs
              // https://w3c.github.io/IndexedDB/#dom-idbfactory-open
              /**
               * Notes:
               *  - `.open` request will hang when attempting to open a new version, while db is being use in other tabs.
               *    - to work around, the 'versionchange' event can be listened for and one can abort any live txns
               *  - `.onerror` event will fire for any event error that isn't caught in the lifetime of the db connection.
               *    - this includes error from deeper events like object store operation requests.
               */
              // upgrade needed handler fired on first (lifetime) db opens or a when new version is passed to `open`
              let upgradeFiber: Fiber.RuntimeFiber<any, any> | null = null
              request.onupgradeneeded = (event) => {
                // Handle database upgrade logic here if needed
                if (config.onUpgrade === undefined) return
                if (event.newVersion === null) {
                  //  this means the database is being deleted.
                  return
                }
                // Because we are bound by this async handler system that lives in JS world
                // not sure how to re-pop back into Effect world to execute any effects
                // for the upgrade logic, besides to runFork it
                const dbConnection = (event.target! as IDBOpenDBRequest).result
                const upgradeService = createUpgradeService(dbConnection, config)
                const startVersion = event.oldVersion + 1
                const endVersion = dbConnection.version

                // Create ordered effects for each version, calling onUpgrade with correct version info
                const migrationEffects = config.onUpgrade(upgradeService)
                const orderedMigrations = []
                for (let version = startVersion; version <= endVersion; version++) {
                  if (migrationEffects[version]) orderedMigrations.push(migrationEffects[version])
                }
                // run the upgrade effect in a fiber. DO NOT run them concurrently
                // todo: make sure that errors within a upgrade/migration can be rolled back without losing data
                upgradeFiber = Effect.runFork(Effect.all(orderedMigrations))
              }
              request.onerror = () => {
                // interrupt any upgrades (not sure if this is needed)
                // dont think `error` event can be fired while in an upgrade event
                if (upgradeFiber) Fiber.interrupt(upgradeFiber)
                if (isKnownDOMException(request.error, IDBRequestExceptionType)) {
                  resume(
                    Effect.fail(
                      new IDBDatabaseOpenError({
                        message: `Async error opening connection.\n${request.error.message}`,
                        config,
                        cause: request.error as TypedDOMException<IDBRequestExceptionType>
                      })
                    )
                  )
                } else {
                  resume(Effect.die(`Unexpected error opening IndexedDB database. ${request.error}`))
                }
              }
              request.onsuccess = () => resume(Effect.succeed(request.result))
            })
            return dbConnection
          })
      }
    })
  )
  static Live = Layer.provide(this.DefaultNoDependencies, IDBFactoryImplementation.live)
  static Test = Layer.provide(this.DefaultNoDependencies, IDBFactoryImplementation.test)
}
