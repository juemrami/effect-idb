import type { Cause } from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as ServiceMap from "effect/ServiceMap"
import type { DomException, IDBObjectStoreCreateIndexError } from "./errors.js"
import {
  IDBDatabaseCreateObjectStoreError,
  IDBDatabaseDeleteObjectStoreError,
  IDBDatabaseOpenError,
  IDBObjectStoreOperationErrorMap
} from "./errors.js"
import {
  type IDBObjectStoreConfig,
  type IDBObjectStoreIndexParams,
  makeObjectStoreProxyService
} from "./idbobjectstore.js"
import { LazyTransactionRegistry, safeAcquireIDBObjectStore } from "./idbtransaction-internal.js"
import type { IDBTransactionParams } from "./idbtransaction.js"

const CONTEXT_PREFIX = "/src/idbdatabase:"

export class IDBFactoryImplementation
  extends ServiceMap.Service<IDBFactoryImplementation, IDBFactory>()(`${CONTEXT_PREFIX}IDBFactory`)
{
  static readonly Browser = Layer.sync(IDBFactoryImplementation, () => window.indexedDB)
  static readonly makeExternal = (indexedDB: IDBFactory) => Layer.sync(IDBFactoryImplementation, () => indexedDB)
}

const createBaseService = Effect.fn(function*(db: IDBDatabase) {
  // handle to raw db connection
  const transactionHistory = yield* Ref.make([] as Array<IDBTransactionParams>)
  const use = <A, E, R>(cb: (db: IDBDatabase) => Effect.Effect<A, E, R>) =>
    Effect.gen(function*() {
      return yield* cb(db)
    })
  return {
    name: db.name,
    version: db.version,
    objectStoreNames: Effect.sync(() => Array.from(db.objectStoreNames) as Array<string>),
    use,
    __transactionHistoryRef: transactionHistory
  }
})

const makeUpgradeObjectStoreService = Effect.fn(function*(storeName: string, upgradeTxn: IDBTransaction) {
  const idbStore = yield* safeAcquireIDBObjectStore(upgradeTxn, storeName)
  const storeProxy = yield* pipe(
    makeObjectStoreProxyService(storeName),
    Effect.provideService(LazyTransactionRegistry, {
      storeNames: Effect.succeed([storeName]),
      acquireObjectStore: () => Effect.succeed(idbStore),
      registerStore: () => Effect.void,
      acquireTransaction: () => Effect.succeed(upgradeTxn),
      setPermissions: () => Effect.void
    })
  )
  return {
    ...storeProxy,
    createIndex: (index: IDBObjectStoreIndexParams) =>
      Effect.try({
        try: () => idbStore.createIndex(index.name, index.keyPath, index.options),
        catch: (error) => {
          const matched = IDBObjectStoreOperationErrorMap.fromUnknown(error, "createIndex")
          if (matched) return matched
          else throw error
        }
      }),
    deleteIndex: (indexName: string) =>
      Effect.try({
        try: () => idbStore.deleteIndex(indexName),
        catch: (error) => {
          const matched = IDBObjectStoreOperationErrorMap.fromUnknown(error, "deleteIndex")
          if (matched) return matched
          else throw error
        }
      })
  }
})
type DBServiceShape = Effect.Success<ReturnType<typeof createBaseService>>
/** Creates a version of IDBDatabaseService with additional methods that can only be used during the IDB's onupgradeneeded handler
 * Object stores accessed via this service's `.objectStore` are similarly extended versions of IDBObjectStoreService.
 */
const createUpgradeService = Effect.fn(
  function*(db: IDBDatabase, config: IDBDatabaseConfig, upgradeTxn: IDBTransaction) {
    // todo: improve typing to exclude CreateIndexError when indexes is empty/undefined
    const createObjectStore = (
      name: string,
      options?: IDBObjectStoreParameters,
      indexes: Array<IDBObjectStoreIndexParams> = []
    ) =>
      pipe(
        Effect.try({
          try: () => db.createObjectStore(name, options),
          catch: (error) => {
            const matched = IDBDatabaseCreateObjectStoreError.fromUnknown(error)
            if (matched) return matched
            else throw error
          }
        }),
        // also create any specified indexes on the store
        Effect.tap((store) =>
          Effect.forEach(indexes, (index) =>
            Effect.try({
              try: () => {
                return store.createIndex(index.name, index.keyPath, index.options)
              },
              catch: (error) => {
                const matched = IDBObjectStoreOperationErrorMap.fromUnknown(error, "createIndex")
                if (matched) return matched
                else throw error
              }
            }))
        )
      )
    const deleteObjectStore = (name: string) => {
      return pipe(Effect.try({
        try: () => db.deleteObjectStore(name),
        catch: (error) => {
          const matched = IDBDatabaseDeleteObjectStoreError.fromUnknown(error)
          if (matched) return matched
          else throw error
        }
      }))
    }
    type KeyPath = string | Array<string>
    const keyPathsMatch = (incoming: KeyPath, existing: KeyPath) => {
      if (Array.isArray(incoming) && Array.isArray(existing)) {
        // both are arrays, check if they match
        return (incoming.length === existing.length &&
          incoming.every((key, index) => key === existing[index]))
      } else if (Array.isArray(incoming) || Array.isArray(existing)) {
        // one is an array, the other is a string, they cannot match
        return false
      } else { // both are strings
        return incoming === existing
      }
    }
    const upsertObjectStore = Effect.fn(
      function*(
        configStore: IDBObjectStoreConfig | { Config: IDBObjectStoreConfig }
      ) {
        const storeConfig = "Config" in configStore ? configStore.Config : configStore
        // check if store already exists & perform any index migrations if so
        if (db.objectStoreNames.contains(storeConfig.name)) {
          // getting the objectstore from the upgrade transaction should never fail here.
          const storeUpgradeService = yield* Effect.orDie(makeUpgradeObjectStoreService(storeConfig.name, upgradeTxn))
          const existingIndexNames = Array.from(
            // upgrade transaction is already open & object store exists, so this should also never fail
            yield* Effect.orDie(storeUpgradeService.indexNames)
          )
          yield* Effect.forEach(
            storeConfig.indexes,
            Effect.fn(function*(incoming) {
              // on existing indexes, check if options match & remake any indexes that differ
              if (existingIndexNames.includes(incoming.name)) {
                const existing = yield* Effect.orDie(storeUpgradeService.index(incoming.name))
                if (
                  !keyPathsMatch(incoming.keyPath, existing.keyPath) ||
                  (incoming.options && existing.unique !== incoming.options.unique) ||
                  (incoming.options && existing.multiEntry !== incoming.options.multiEntry)
                ) {
                  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/deleteIndex#exceptions
                  yield* pipe(
                    storeUpgradeService.deleteIndex(incoming.name),
                    // Shouldn't error since index exists and we are in a versionchange txn
                    Effect.orDie,
                    Effect.andThen(storeUpgradeService.createIndex(incoming)),
                    // In this context index creation actually can still fail if:
                    // keyPath & multiEntry combination is invalid, or keyPath is invalid
                    Effect.catchTag("IDBObjectStoreCreateIndexError", (e) => {
                      if (e.cause.name === "InvalidAccessError" || e.cause.name === "SyntaxError") {
                        return Effect.fail(
                          e as IDBObjectStoreCreateIndexError & {
                            cause: DomException<"InvalidAccessError" | "SyntaxError">
                          }
                        )
                      }
                      throw e // defect if unexpected error
                    })
                  )
                }
              } else { // for newly declared indexes simply create them
                yield* pipe(
                  storeUpgradeService.createIndex(incoming),
                  Effect.catchTag("IDBObjectStoreCreateIndexError", (e) => {
                    if (e.cause.name === "InvalidAccessError" || e.cause.name === "SyntaxError") {
                      return Effect.fail(
                        e as IDBObjectStoreCreateIndexError & {
                          cause: DomException<"InvalidAccessError" | "SyntaxError">
                        }
                      )
                    }
                    throw e
                  })
                )
              }
            })
          )
          // delete any indexes that no longer exist in the config (assumed deprecated)
          yield* Effect.forEach(
            existingIndexNames,
            Effect.fn(function*(indexName) {
              if (!storeConfig.indexes?.some((index) => index.name === indexName)) {
                yield* storeUpgradeService.deleteIndex(indexName).pipe(
                  // again, shouldn't error since index exists and we are in a versionchange txn
                  Effect.orDie
                )
              }
            })
          )
        } else { // create the store and any indexes
          yield* pipe(
            createObjectStore(storeConfig.name, storeConfig.params, storeConfig.indexes),
            // In this context creating a store this can still fail if:
            // InvalidAccessError (invalid autoIncrement and keyPath combination), SyntaxError (invalid keyPath or options)
            Effect.catchTag("IDBDatabaseCreateObjectStoreError", (e) => {
              if (e.cause.name === "InvalidAccessError" || e.cause.name === "SyntaxError") {
                return Effect.fail(
                  e as IDBDatabaseCreateObjectStoreError & {
                    cause: DomException<"InvalidAccessError" | "SyntaxError">
                  }
                )
              }
              throw e
            })
          )
        }
      }
    )
    return {
      ...yield* createBaseService(db),
      /** Creates an object store and any defined indexes on the idb database*/
      createObjectStore,
      /** Deletes an object store and any indexes from the idb database */
      deleteObjectStore,
      transaction: {
        /** Access to raw handle for the "versionchange" IDBTransaction */
        use: <A, E, R>(cb: (txn: IDBTransaction) => Effect.Effect<A, E, R>) => cb(upgradeTxn),
        /** IDBObjectStoreService extended with `createIndex` and `deleteIndex` methods */
        objectStore: (storeName: string) => makeUpgradeObjectStoreService(storeName, upgradeTxn)
      } as const,
      /** Automatically generate defined object stores and their indexes. Destructively validates index configurations. */
      autoGenerateObjectStores: Effect.forEach(config.autoObjectStores ?? [], upsertObjectStore)
    }
  }
)
export type IDBDatabaseConfig = {
  /** The name of the database */
  name: string
  /** Database version. If omitted with either:
   * 1. Create a new database with version `1` IFF the database does not yet exist. \
   * or
   * 2. Open the latest version of the database if it already exists.
   */
  // Note: with `exactOptionalPropertyTypes: true`, callers setting `version: undefined`
  // must be explicitly allowed. Hence `number | undefined`.
  version?: number | undefined
  /** Array of object store configurations include in the auto upgrade process of `upgradeService.autoGenerateObjectStores` */
  autoObjectStores?: Array<IDBObjectStoreConfig | { Config: IDBObjectStoreConfig }>
  /** `Record` of effects for each database version describing any schema changes (object stores name and their indices). \
   * If an effect is not provided for a version, the upgrade service will automatically create any object stores
   * defined in `autoObjectStores` via `upgradeService.autoGenerateObjectStores()`. \
   * This is in contrast to the standard IDB behavior, which does not create any object stores
   * unless explicitly defined during the upgrade process. */
  onUpgradeNeeded?: (
    upgradeService: Effect.Success<ReturnType<typeof createUpgradeService>>
  ) => Record<number, Effect.Effect<any, any, never>>
}
export class IDBDatabaseService
  extends ServiceMap.Service<IDBDatabaseService, DBServiceShape>()(`${CONTEXT_PREFIX}DatabaseService`)
{
  static make = (config: IDBDatabaseConfig) =>
    Layer.effect(
      IDBDatabaseService,
      Effect.gen(function*() {
        const dbFactory = yield* IDBFactoryService
        const connection = yield* Effect.acquireRelease(
          dbFactory.open(config),
          /**
           * `close` is automatically handled by the browser on page unload
           * only times you'd want to explicitly close is when we want to because of:
           * - new database version opened on another tab
           * - or before db version upgrades
           * - or db deletions (new db connections cant upgrade till old ones are closed)
           * - .close raises no errors
           */
          (db) => Effect.sync(() => db.close())
        )
        return yield* createBaseService(connection)
      })
    )
  static makeLive = (config: IDBDatabaseConfig) =>
    Layer.provide(
      IDBDatabaseService.make(config),
      IDBFactoryService.Live
    )
  static makeTest = (config: IDBDatabaseConfig, indexedDB: IDBFactory) =>
    Layer.provide(
      IDBDatabaseService.make(config),
      IDBFactoryService.makeTest(indexedDB)
    )
}
export class IDBFactoryService extends ServiceMap.Service<IDBFactoryService>()(`${CONTEXT_PREFIX}FactoryService`, {
  make: Effect.gen(function*() {
    const indexedDB = yield* IDBFactoryImplementation
    return {
      open: (config: IDBDatabaseConfig) =>
        Effect.gen(function*() {
          // Read to understand possible order of the event cbs
          // https://w3c.github.io/IndexedDB/#dom-idbfactory-open
          /**
           * Notes:
           *  - `.open` request will hang when attempting to open a new version, while db is being use in other tabs.
           *    - to work around, the 'versionchange' event can be listened for and one can abort any live txns
           *  - `.onerror` event will fire for any event error that isn't caught in the lifetime of the db connection.
           *    - this includes error from deeper events like object store operation requests.
           */
          const request = yield* Effect.try({
            // https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open#exceptions
            try: () => indexedDB.open(config.name, config.version),
            catch: (error) => {
              const matched = IDBDatabaseOpenError.fromUnknown(error, config)
              if (matched) return matched
              else throw error // defect with original error
            }
          })

          const makeUpgradeEffect = (
            rawDatabase: IDBDatabase,
            rawUpgradeTxn: IDBTransaction,
            migrationStartVersion: number,
            migrationEndVersion: number
          ) =>
            pipe(
              createUpgradeService(rawDatabase, config, rawUpgradeTxn),
              Effect.map((upgradeService) => {
                const definedVersionMigrations = config.onUpgradeNeeded ? config.onUpgradeNeeded(upgradeService) : {}
                const orderedMigrations = []
                for (let version = migrationStartVersion; version <= migrationEndVersion; version++) {
                  if (definedVersionMigrations[version]) orderedMigrations.push(definedVersionMigrations[version])
                  else if (config.autoObjectStores?.length) {
                    // if no migration effect declared for this version, auto generate any objectStores in `autoObjectStores`.
                    // This is an opinion, standard api behavior would not create any object stores unless explicitly defined
                    orderedMigrations.push(upgradeService.autoGenerateObjectStores)
                  }
                }
                return orderedMigrations as Array<
                  Effect.Effect<
                    any,
                    Effect.Error<
                      Effect.Success<
                        ReturnType<typeof createUpgradeService>
                      >["autoGenerateObjectStores"]
                    >
                  >
                >
              }),
              // run the upgrade effect synchronously. _DO NOT_ run them concurrently
              Effect.andThen((migrations) => Effect.all(migrations))
            )
          // Register upgrade handler synchronously to avoid races with success/error
          type UpgradeFailCause = Cause<Effect.Error<ReturnType<typeof makeUpgradeEffect>>>
          let failCause: UpgradeFailCause | undefined = undefined
          request.onupgradeneeded = async (event: IDBVersionChangeEvent) => {
            if (config.onUpgradeNeeded === undefined && config.autoObjectStores === undefined) return
            if (event.newVersion === null) return // database is being deleted
            const rawDatabase = request.result
            const rawUpgradeTxn = request.transaction!
            const migrationStartVersion = event.oldVersion + 1
            const migrationEndVersion = rawDatabase.version
            const upgradeResult = await Effect.runPromiseExit(
              makeUpgradeEffect(
                rawDatabase,
                rawUpgradeTxn,
                migrationStartVersion,
                migrationEndVersion
              )
            )
            const upgradeFailCause = Exit.match(upgradeResult, {
              onFailure: (cause) => {
                // Note: idb spec do not _require_ upgrade transactions to auto abort on error,
                // though in practice all browser implementations seem to do it. Adding it here to be safe.
                rawUpgradeTxn.abort()
                return cause
              },
              onSuccess: () => undefined
            })
            // note this error type will NOT get passed to the request.onerror event, it will be DOMException
            if (upgradeFailCause) failCause = upgradeFailCause
          }
          const dbConnection = yield* Effect.tryPromise({
            try: (signal) =>
              new Promise<IDBDatabase>((resolve, reject) => {
                const onError = () => reject(request.error)
                const onSuccess = () => resolve(request.result)
                request.addEventListener("error", onError)
                request.addEventListener("success", onSuccess)
                const cleanup = () => {
                  request.onupgradeneeded = null
                  request.removeEventListener("error", onError)
                  request.removeEventListener("success", onSuccess)
                }
                signal.onabort = cleanup
              }),
            catch: (error) => {
              const matched = IDBDatabaseOpenError.fromUnknown(error, config, true)
              if (matched && failCause) (matched as any).upgradeCause = failCause
              if (matched) return matched
              else throw error
            }
          })
          return dbConnection
        })
    }
  })
}) {
  private static Default = Layer.effect(IDBFactoryService, this.make)
  static Live = Layer.provide(this.Default, IDBFactoryImplementation.Browser)
  static makeTest = (idbFactory: IDBFactory) =>
    Layer.provide(this.Default, IDBFactoryImplementation.makeExternal(idbFactory))
}
