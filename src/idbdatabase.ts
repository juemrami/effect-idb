import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type { RuntimeFiber } from "effect/Fiber"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import {
  IDBDatabaseCreateObjectStoreError,
  IDBDatabaseDeleteObjectStoreError,
  IDBDatabaseOpenError,
  IDBObjectStoreCreateIndexError
} from "./errors.js"
import {
  type IDBObjectStoreConfig,
  type IDBObjectStoreIndexParams,
  makeObjectStoreProxyService
} from "./idbobjectstore.js"
import type { IDBTransactionParams } from "./idbtransaction.js"
import { getRawObjectStoreFromRawTransactionEffect, TransactionRegistryService } from "./idbtransaction.js"

const CONTEXT_PREFIX = "/src/idbdatabase:"

export class IDBFactoryImplementation
  extends Context.Tag(`${CONTEXT_PREFIX}IDBFactory`)<IDBFactoryImplementation, IDBFactory>()
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
type DBServiceShape = Effect.Effect.Success<ReturnType<typeof createBaseService>>

const createUpgradeService = (db: IDBDatabase, config: IDBDatabaseConfig, upgradeTxn: IDBTransaction) => {
  const baseService = Effect.runSync(createBaseService(db))
  const addStoreIndex = (
    store: IDBObjectStore,
    index: IDBObjectStoreIndexParams
  ) =>
    Effect.try({
      try: () => {
        return store.createIndex(index.name, index.keyPath, index.options)
      },
      catch: (error) => {
        const matched = IDBObjectStoreCreateIndexError.fromUnknown(error)
        if (matched) return matched
        else throw error
      }
    })
  // todo: improve typing to exclude CreateIndexError when indexes is empty/undefined
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
          const matched = IDBDatabaseCreateObjectStoreError.fromUnknown(error)
          if (matched) return matched
          else throw error
        }
      }),
      // create any specified indexes on the store
      Effect.tap((store) => Effect.forEach(indexes, (index) => addStoreIndex(store, index)))
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
  return {
    ...baseService,
    createObjectStore,
    deleteObjectStore,
    /** Effect handle to the "versionchange" IDBTransaction */
    useTransaction: <A, E, R>(cb: (txn: IDBTransaction) => Effect.Effect<A, E, R>) => cb(upgradeTxn),
    objectStore: Effect.fn(function*(storeName) {
      return yield* makeObjectStoreProxyService(storeName).pipe(Effect.provideService(TransactionRegistryService, {
        // Mock registry service for upgrade transactions
        addStore: (_) => baseService.objectStoreNames.pipe(Effect.map((stores) => new Set(stores))),
        storeNames: baseService.objectStoreNames, // empty set of stores for upgrade transactions
        makeTransaction: () => Effect.succeed(upgradeTxn), // use the upgrade transaction
        useObjectStore: (storeName) => getRawObjectStoreFromRawTransactionEffect(upgradeTxn, storeName),
        setPermissions: () => Effect.void // upgrade transactions are always readwrite
      }))
    }),
    /** Automatically generate defined object stores and their indexes. Destructively validates index configurations. */
    autoGenerateObjectStores: Effect.gen(function*() {
      // Create all object stores if they don't exist
      yield* Effect.forEach(config.autoObjectStores ?? [], (store) =>
        Effect.gen(function*() {
          const storeConfig = "Config" in store ? store.Config : store
          // if the store config is a layer, extract the config
          // check if store already exists & perform any index migrations if so
          if (db.objectStoreNames.contains(storeConfig.name)) {
            const store = yield* getRawObjectStoreFromRawTransactionEffect(upgradeTxn, storeConfig.name)
            const existingIndexNames = Array.from(store.indexNames)
            // Add or modify indexes
            yield* Effect.forEach(
              storeConfig.indexes,
              Effect.fn(function*(incoming) {
                if (existingIndexNames.includes(incoming.name)) {
                  // on existing, check if options match & remake any indexes that differ
                  // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/index#exceptions
                  const existing = store.index(incoming.name) // todo: sync error handling
                  if (
                    !keyPathsMatch(incoming.keyPath, existing.keyPath) ||
                    (incoming.options && existing.unique !== incoming.options.unique) ||
                    (incoming.options && existing.multiEntry !== incoming.options.multiEntry)
                  ) {
                    // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/deleteIndex#exceptions
                    store.deleteIndex(incoming.name) // todo: sync error handling
                    yield* addStoreIndex(store, incoming)
                  }
                } else {
                  // Add any new indexes
                  yield* addStoreIndex(store, incoming)
                }
              })
            )
            // Finally delete any indexes that no longer exist in the config (assumed deprecated)
            existingIndexNames.forEach((indexName) => {
              if (!storeConfig.indexes?.some((index) => index.name === indexName)) {
                store.deleteIndex(indexName) // todo: sync error handling
              }
            })
          } else {
            // create the store and any indexes
            yield* createObjectStore(
              storeConfig.name,
              storeConfig.params,
              storeConfig.indexes
            )
          }
        }))
    })
  }
}
export type IDBDatabaseConfig = {
  /** The name of the database */
  name: string
  /** Database version. If omitted with either:
   * 1. Create a new database with version `1` IFF the database does not yet exist. \
   * or
   * 2. Open the latest version of the database if it already exists.
   */
  version?: number
  /** Array of object store configurations include in the auto upgrade process of `upgradeService.autoGenerateObjectStores` */
  autoObjectStores?: Array<IDBObjectStoreConfig | { Config: IDBObjectStoreConfig }>
  /** `Record` of effects for each database version describing any schema changes (object stores name and their indices). \
   * If an effect is not provided for a version, the upgrade service will automatically create any object stores
   * defined in `autoObjectStores` via `upgradeService.autoGenerateObjectStores()`. \
   * This is in contrast to the standard IDB behavior, which does not create any object stores
   * unless explicitly defined during the upgrade process. */
  onUpgradeNeeded?: (
    upgradeService: ReturnType<typeof createUpgradeService>
  ) => Record<number, Effect.Effect<any, any, never>>
}
export class IDBDatabaseService
  extends Context.Tag(`${CONTEXT_PREFIX}DatabaseService`)<IDBDatabaseService, DBServiceShape>()
{
  static make = (config: IDBDatabaseConfig) =>
    Layer.scoped(
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
// unsure if this wrapper is needed or just makes this more complex.
export class IDBFactoryService extends Context.Tag(`${CONTEXT_PREFIX}FactoryService`)<
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
              // https://developer.mozilla.org/en-US/docs/Web/API/IDBFactory/open#exceptions
              try: () => indexedDB.open(config.name, config.version),
              catch: (error) => {
                const matched = IDBDatabaseOpenError.fromUnknown(error, config)
                if (matched) return matched
                else throw error // defect with original error
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
              let upgradeFiber: RuntimeFiber<Array<any>, any> | undefined
              // upgrade needed handler fired on first (lifetime) db opens or a when new version is passed to `open`
              request.onupgradeneeded = (event) => {
                if (config.onUpgradeNeeded === undefined && config.autoObjectStores === undefined) return
                if (event.newVersion === null) { //
                  //  this means the database is being deleted.
                  return
                }
                // Because we are bound by this async handler system that lives in JS world
                // not sure how to re-pop back into Effect world to execute any effects for the upgrade logic,
                // (besides to runSync it
                const dbConnection = (event.target! as IDBOpenDBRequest).result
                // special "versionchange" transaction used in the upgrade service
                const transaction = (event.target! as IDBOpenDBRequest).transaction!
                const startVersion = event.oldVersion + 1
                const endVersion = dbConnection.version

                // Create ordered effects for each version
                const upgradeService = createUpgradeService(dbConnection, config, transaction)
                const migrationEffects = config.onUpgradeNeeded ? config.onUpgradeNeeded(upgradeService) : {}
                const orderedMigrations = []
                for (let version = startVersion; version <= endVersion; version++) {
                  if (migrationEffects[version]) orderedMigrations.push(migrationEffects[version])
                  // if no migration effect declared for this version, auto generate any object stores
                  // this is an opinion, standard api behavior is to not create any object stores unless explicitly defined
                  else if (config.autoObjectStores?.length) {
                    orderedMigrations.push(upgradeService.autoGenerateObjectStores)
                  }
                }
                // run the upgrade effect synchronously. DO NOT run them concurrently
                // todo: make sure that errors within a upgrade/migration can be rolled back without losing data
                upgradeFiber = Effect.runFork(Effect.all(orderedMigrations))
                Effect.runPromiseExit(Fiber.await(upgradeFiber)).then(
                  (awaitFiberExit) => {
                    Exit.match(awaitFiberExit, {
                      onSuccess: (upgradeEffectExit) => {
                        Exit.match(upgradeEffectExit, {
                          onSuccess: () => Effect.void, // use the onsuccess handler to `resume` the db connection
                          onFailure: (cause) => {
                            resume(Effect.fail(
                              new IDBDatabaseOpenError({
                                message: `Error occurred during database upgrade process.\n${cause}`,
                                // @ts-ignore: todo proper error type propagation for the upgrade service
                                cause
                              })
                            ))
                          }
                        })
                      },
                      onFailure: (cause) => resume(Effect.die(`Unexpected error during upgrade process. ${cause}`))
                    })
                  }
                )
              }
              request.onerror = () => {
                const matched = IDBDatabaseOpenError.fromUnknown(request.error, config, true)
                if (matched) {
                  resume(Effect.fail(matched))
                } else {
                  resume(Effect.die(request.error))
                }
              }
              request.onsuccess = () => {
                if (upgradeFiber) {
                  resume(pipe(
                    Fiber.await(upgradeFiber),
                    Effect.andThen((exit) =>
                      Exit.match(exit, {
                        onFailure: (cause) => {
                          return Effect.fail(
                            new IDBDatabaseOpenError({
                              message: `Error occurred during database upgrade process.\n${cause}`,
                              // @ts-ignore: todo propper error type propagation for the upgrade service
                              cause
                            })
                          )
                        },
                        onSuccess: () => Effect.succeed(request.result)
                      })
                    )
                  ))
                } else {
                  resume(Effect.succeed(request.result))
                }
              }
            })
            return dbConnection
          })
      }
    })
  )
  static Live = Layer.provide(this.DefaultNoDependencies, IDBFactoryImplementation.Browser)
  static makeTest = (idbFactory: IDBFactory) =>
    Layer.provide(
      this.DefaultNoDependencies,
      IDBFactoryImplementation.makeExternal(idbFactory)
    )
}
