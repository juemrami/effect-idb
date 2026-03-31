import { Cause, Console, Effect, Exit, Layer, pipe, ServiceMap } from "effect"
import { indexedDB } from "fake-indexeddb"
import { assert, describe, expect, it } from "vitest"
import { IDBDatabaseOpenError, IDBDatabaseTransactionOpenError } from "../src/errors.js"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import type { IDBObjectStoreConfig, IDBObjectStoreIndexParams } from "../src/idbobjectstore.js"
import { IDBObjectStoreService } from "../src/idbobjectstore.js"
import { IDBTransactionService } from "../src/idbtransaction.js"
import { createDatabaseTestRuntime } from "./runtime.js"

const ContactObjectStoreConfig = {
  name: "contacts",
  params: {
    keyPath: "id",
    autoIncrement: true
  },
  indexes: [
    { name: "name", keyPath: "name" },
    { name: "email", keyPath: "email" }
  ]
}
type Contact = {
  id?: number
  name: string
  email: string
}
class ContactObjectStore extends ServiceMap.Service<ContactObjectStore>()(
  "ContactObjectStore",
  {
    make: Effect.gen(function*() {
      return yield* IDBObjectStoreService
    })
  }
) {
  static Default = Layer.provide(
    Layer.effect(ContactObjectStore, this.make),
    IDBObjectStoreService.make(ContactObjectStoreConfig.name)
  )
  static Config = ContactObjectStoreConfig
}

const NotesObjectStoreConfig: IDBObjectStoreConfig = {
  name: "notes",
  params: {
    keyPath: "id",
    autoIncrement: true
  },
  indexes: [
    { name: "title", keyPath: "title" },
    { name: "createdAt", keyPath: "createdAt" }
  ]
}
class NotesObjectStore extends ServiceMap.Service<NotesObjectStore>()(
  "NotesObjectStore",
  {
    make: Effect.gen(function*() {
      return yield* IDBObjectStoreService
    })
  }
) {
  static Default = Layer.provide(
    Layer.effect(NotesObjectStore, this.make),
    IDBObjectStoreService.make(NotesObjectStoreConfig.name)
  )
  static Config = NotesObjectStoreConfig
}

describe("Database Upgrade Service", () => {
  it("should auto generate new object stores on database upgrade events", async () => {
    const dbName = "testDB"
    indexedDB.deleteDatabase(dbName)
    const runtime = createDatabaseTestRuntime({
      name: dbName,
      version: 1,
      // maybe this could be a way to define object stores that will be automatically created when not present
      autoObjectStores: [ContactObjectStoreConfig, NotesObjectStoreConfig],
      onUpgradeNeeded: (upgradeService) => ({
        1: upgradeService.autoGenerateObjectStores
      })
    })

    // Create a program to test auto-creation of object stores
    const testProgram = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const contactKey = yield* contactStore.put({ name: "Auto Created", email: "auto@example.com" })
      const retrievedContact = yield* contactStore.get(contactKey)
      return { contactKey, retrievedContact }
    }).pipe(
      Effect.provide(
        Layer.provide(
          ContactObjectStore.Default,
          IDBTransactionService.ReadWrite
        )
      )
    )
    // Execute the test program
    const result = await runtime.runPromise(testProgram)

    // Verify the auto-created object store works as expected
    expect(result.retrievedContact).toEqual(
      expect.objectContaining({ name: "Auto Created", email: "auto@example.com" })
    )
    // Clean up
    runtime.dispose()
  })

  it("should handle auto migrations of object store index schemas", async () => {
    const dbName = "indexAutoMigrationTestDB"
    indexedDB.deleteDatabase(dbName)
    // Define different index schemas for different versions
    const INDEX_SCHEMAS: Record<number, Array<IDBObjectStoreIndexParams>> = {
      1: [
        { name: "name", keyPath: "name" }
      ],
      // add index
      2: [
        { name: "name", keyPath: "name" },
        { name: "email", keyPath: "email" }
      ],
      // remove index
      3: [
        { name: "email", keyPath: "email" },
        { name: "createdAt", keyPath: "createdAt", options: { unique: true } },
        // cannot have multi entry on multiple key paths?
        { name: "compositeKey", keyPath: ["createdAt", "email"], options: { unique: true } }
      ],
      // we need a case where the options change only
      4: [
        { name: "name", keyPath: "name" },
        { name: "email", keyPath: "email" },
        { name: "createdAt", keyPath: "createdAt", options: { unique: false } },
        { name: "compositeKey", keyPath: ["name", "email"], options: { unique: false } }
      ]
    }
    const MAX_VERSION = Object.keys(INDEX_SCHEMAS).map(Number).reduce((max, v) => Math.max(max, v), 0)
    for (let version = 1; version <= MAX_VERSION; version++) {
      // Use unique database name for each version to avoid interference
      const targetSchema = INDEX_SCHEMAS[Number(version)]
      const runtime = createDatabaseTestRuntime({
        name: dbName,
        version: Number(version),
        autoObjectStores: [{ ...ContactObjectStoreConfig, indexes: targetSchema }]
        // No need to provide onUpgradeNeeded here since we are testing auto migrations
        // onUpgradeNeeded: (upgradeService) => ({
        //   1: upgradeService.autoGenerateObjectStores,
        //   2: upgradeService.autoGenerateObjectStores,
        //   3: upgradeService.autoGenerateObjectStores,
        //   4: upgradeService.autoGenerateObjectStores
        // })
      })

      // Inspect the current schema of the contacts object store
      const getObjectSchemaEffect = Effect.gen(function*() {
        // const contactStore = yield* ContactObjectStore
        const txn = yield* IDBTransactionService
        const results = yield* txn.use((idbTxn) =>
          Effect.sync(() => {
            const store = idbTxn.objectStore(ContactObjectStoreConfig.name)
            const indexes: Array<IDBObjectStoreIndexParams> = []
            const indexNames = Array.from(store.indexNames)
            for (const name of indexNames) {
              indexes.push({
                name,
                keyPath: store.index(name).keyPath as string,
                options: {
                  multiEntry: store.index(name).multiEntry,
                  unique: store.index(name).unique
                }
              })
            }
            return indexes
          }), {
          storeNames: [ContactObjectStoreConfig.name]
        })
        return results
      }).pipe(
        Effect.provide(
          IDBTransactionService.ReadOnly
        )
      )

      const schemaOut = await runtime.runPromise(getObjectSchemaEffect)
      runtime.dispose()
      expect(schemaOut.length).toBe(targetSchema.length)
      const sortedTargetSchema = targetSchema.map((index) => ({
        ...index,
        // apply default missing options to target schema
        options: {
          multiEntry: index.options?.multiEntry ?? false,
          unique: index.options?.unique ?? false
        }
      })).sort((a, b) => a.name.localeCompare(b.name))

      const sortedSchemaOut = schemaOut.sort((a, b) => a.name.localeCompare(b.name))
      expect(JSON.stringify(sortedSchemaOut)).toEqual(JSON.stringify(sortedTargetSchema))
    }
  })

  it("should handle working with object stores within an upgrade needed effect", async () => {
    const dbName = "upgradeObjectStoreTestDB"
    indexedDB.deleteDatabase(dbName)

    type Note = {
      id?: number
      title: string
      content: string
      createdAt: Date
    }
    const runtime = createDatabaseTestRuntime({
      name: dbName,
      version: 2,
      autoObjectStores: [ContactObjectStoreConfig, NotesObjectStoreConfig],
      onUpgradeNeeded: (upgradeService) => ({
        // If all you're doing is the auto migration for a version, it can be omitted here
        // the default behavior is to fallback to autoGenerateObjectStores
        // 1: upgradeService.autoGenerateObjectStores,
        2: Effect.gen(function*() {
          yield* upgradeService.autoGenerateObjectStores // incase new object stores/indexes are added
          const contacts = yield* upgradeService.transaction.objectStore(ContactObjectStoreConfig.name)
          const notes = yield* upgradeService.transaction.objectStore(NotesObjectStoreConfig.name)
          const key = yield* contacts.add({ name: "Upgrade Test", email: "upgrade@test.com" })
          yield* Console.log(`Added contact with key: ${key}`)
          yield* notes.add({
            title: "Upgrade Note",
            content: "This note was created during upgrade",
            createdAt: new Date()
          })
          yield* Console.log(`Added note with key: ${key}`)
          return true
        })
      })
    })
    const testProgram = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const noteStore = yield* NotesObjectStore

      // Verify the contacts store has the upgrade test contact
      const contact = yield* contactStore.get<Contact>(1)
      expect(contact).toBeDefined()
      expect(contact!.name).toBe("Upgrade Test")

      // Verify the notes store has the upgrade test note
      const note = yield* noteStore.get<Note>(1)
      expect(note).toBeDefined()
      expect(note!.title).toBe("Upgrade Note")
    }).pipe(
      Effect.provide(
        Layer.provide(
          Layer.mergeAll(
            ContactObjectStore.Default,
            NotesObjectStore.Default
          ),
          IDBTransactionService.ReadWrite
        )
      )
    )

    const result = await runtime.runPromise(testProgram)
    expect(result).toBeUndefined() // Should complete without errors
  })
  it("should roll back any index schema changes after an unexpected upgrade failure", async () => {
    const dbName = "indexRollbackTestDB"
    indexedDB.deleteDatabase(dbName)

    // step 1 declare and object store with an index schema
    const UnexpectedUpgradeError = new Error("Unexpected Upgrade Error")
    const makeDbLayer = (version?: number) => {
      return IDBDatabaseService.layer({
        name: dbName,
        version, // undefined opens to latest db version
        autoObjectStores: [{
          ...ContactObjectStoreConfig,
          indexes: [
            { name: "name", keyPath: "name" },
            { name: "email", keyPath: "email" },
            { name: "createdAt", keyPath: "createdAt", options: { unique: false } },
            { name: "compositeKey", keyPath: ["name", "email"], options: { unique: false } }
          ]
        }],
        onUpgradeNeeded: (upgradeService) => ({
          1: upgradeService.autoGenerateObjectStores,
          // step 2: modify part of the index schema, ensure it was changed
          2: Effect.gen(function*() {
            const store = yield* upgradeService.transaction.use((upgradeTxn) =>
              Effect.gen(function*() {
                upgradeTxn.objectStore(ContactObjectStoreConfig.name).deleteIndex("createdAt")
                const store = upgradeTxn.objectStore(ContactObjectStoreConfig.name)
                return yield* Effect.succeed(store)
              })
            )
            const indexNames = Array.from(store.indexNames)
            expect(indexNames).not.toContain("createdAt")
            // step 3: cause and error in the upgrade process
            yield* Console.log("failing")
            yield* Effect.fail(UnexpectedUpgradeError)
          })
        })
      }, indexedDB)
    }
    const dbWithUpgradeFailureLayer = makeDbLayer(2)
    const dbLayer = makeDbLayer() // for running verification steps
    const upgradeFailureExit = await Effect.runPromiseExit(
      pipe(
        Console.log("Running upgrade test..."), // this wont be reached, will fail on dbLayer construction
        Effect.provide(dbWithUpgradeFailureLayer)
        // Effect.catchDefect((_) => Effect.fail(UnexpectedUpgradeError))
      )
    )
    Exit.match(upgradeFailureExit, {
      onFailure: (cause) => {
        expect(cause.reasons.length).toBe(1)
        const reason = cause.reasons[0]
        expect(Cause.isFailReason(reason)).toBe(true)
        const error = (reason as Cause.Fail<IDBDatabaseOpenError>).error
        expect(error).toBeInstanceOf(IDBDatabaseOpenError)
        expect(error.cause.name).toBe("AbortError")
        const upgradeCause = error.upgradeCause
        expect(upgradeCause).toBeDefined()
        const upgradeCauseReason = upgradeCause?.reasons[0] as Cause.Fail<unknown>
        expect(Cause.isFailReason(upgradeCauseReason)).toBe(true)
        expect((upgradeCauseReason as Cause.Fail<unknown>).error).toBeInstanceOf(UnexpectedUpgradeError.constructor)
      },
      onSuccess: (_) => {
        assert(false, "Expected upgrade to fail, but it succeeded")
      }
    })

    // step 4: verify the index schema was rolled back to the original state
    const rollbackExit = await Effect.runPromiseExit(pipe(
      Effect.gen(function*() {
        const database = yield* IDBDatabaseService
        expect(database.version).toBe(1) // rolled back to version 1
        const txn = yield* IDBTransactionService
        const store = yield* txn.use((idbTxn) => Effect.sync(() => idbTxn.objectStore(ContactObjectStoreConfig.name)), {
          storeNames: [ContactObjectStoreConfig.name]
        })
        const indexNames = Array.from(store.indexNames)
        expect(indexNames).toContain("createdAt")
      }),
      Effect.provide(IDBTransactionService.ReadOnly),
      Effect.provide(dbLayer)
    ))
    Exit.match(rollbackExit, {
      onFailure: (cause) => {
        assert(false, "Rollback verification failed but expected to succeed. \n" + cause)
      },
      // success means the index schema is as expected
      onSuccess: (_) => void 0
    })
  })
  it("should roll back any object store __SET__ changes after an upgrade failure", async () => {
    const dbName = "objectDataRollbackTestDB"
    indexedDB.deleteDatabase(dbName)

    const UnexpectedUpgradeError = new Error("Unexpected Upgrade Error")
    const StoreSet = [ContactObjectStore, NotesObjectStore]
    const createDbLayer = (version?: number) =>
      IDBDatabaseService.layer({
        name: dbName,
        version,
        autoObjectStores: StoreSet,
        onUpgradeNeeded: (upgradeService) => ({
          1: Effect.gen(function*() {
            // todo: this should yield* the created stores
            yield* upgradeService.autoGenerateObjectStores
            const storeNames = yield* upgradeService.objectStoreNames
            // verify the data was added
            for (const store of StoreSet) {
              expect(storeNames).toContain(store.Config.name)
            }
            expect(storeNames.length).toBe(StoreSet.length)
          }),
          2: Effect.gen(function*() {
            // delete a datastore
            yield* upgradeService.deleteObjectStore(StoreSet[1].Config.name)
            const storeNames = yield* upgradeService.objectStoreNames
            expect(storeNames).not.toContain(StoreSet[1].Config.name)
            expect(storeNames.length).toBe(StoreSet.length - 1)
            // step 3: cause an error in the upgrade process
            yield* Effect.fail(UnexpectedUpgradeError)
          })
        })
      }, indexedDB)

    const dbWithUpgradeFailureLayer = createDbLayer(2)
    const dbLayer = createDbLayer() // for running verification steps
    const upgradeFailureExit = await Effect.runPromiseExit(
      pipe(
        Console.log("Running upgrade test..."), // this wont be reached, will fail on dbLayer construction
        Effect.provide(dbWithUpgradeFailureLayer),
        Effect.catchDefect((_) => Effect.fail(UnexpectedUpgradeError))
      )
    )
    Exit.match(upgradeFailureExit, {
      onFailure: (cause) => {
        expect(cause.reasons.length).toBe(1)
        const reason = cause.reasons[0]
        expect(Cause.isFailReason(reason)).toBe(true)
        const error = (reason as Cause.Fail<IDBDatabaseOpenError>).error
        expect(error).toBeInstanceOf(IDBDatabaseOpenError)
        expect(error.cause.name).toBe("AbortError")
        const upgradeCause = error.upgradeCause
        expect(upgradeCause).toBeDefined()
        const upgradeCauseReason = upgradeCause?.reasons[0] as Cause.Fail<unknown>
        expect(Cause.isFailReason(upgradeCauseReason)).toBe(true)
        expect((upgradeCauseReason as Cause.Fail<unknown>).error).toBeInstanceOf(UnexpectedUpgradeError.constructor)
      },
      onSuccess: (_) => {
        assert(false, "Expected upgrade process to fail, but succeeded")
      }
    })

    // step 4: verify the set was rolled back to the original state
    const rollbackExit = await Effect.runPromiseExit(pipe(
      Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        expect(db.version).toBe(1) // rolled back to version 1
        return yield* db.objectStoreNames
      }),
      Effect.provide(dbLayer)
    ))
    Exit.match(rollbackExit, {
      onFailure: (cause) => {
        assert(false, "Rollback verification failed but expected to succeed. \n" + cause)
      },
      onSuccess: (storNames) => {
        expect(storNames).toEqual(StoreSet.map((store) => store.Config.name))
      }
    })
  })
  it("should skip auto-generating object stores when a custom upgrade function is provided", async () => {
    const dbName = "customUpgradeTestDB"
    indexedDB.deleteDatabase(dbName)

    const runtime = createDatabaseTestRuntime({
      name: dbName,
      version: 1,
      autoObjectStores: [ContactObjectStoreConfig],
      onUpgradeNeeded: (_) => ({
        1: Effect.void // Skip auto generation
      })
    })

    const testProgram = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      return yield* contactStore.get<Contact>(1)
    }).pipe(
      Effect.provide(
        Layer.provide(
          ContactObjectStore.Default,
          IDBTransactionService.ReadWrite
        )
      ),
      Effect.flip
    )

    const result = await runtime.runPromise(testProgram)
    // expect result to be an object store not found transaction error
    expect(result).toBeInstanceOf(IDBDatabaseTransactionOpenError)
    expect((result as IDBDatabaseTransactionOpenError).cause.name).toBe("NotFoundError")
    runtime.dispose()
  })

  it("should correctly represent current objectstore names", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "objectStoreContextTestDB",
      version: 1,
      autoObjectStores: [],
      onUpgradeNeeded: (upgradeService) => ({
        // If all you're doing is the auto migration for a version, it can be omitted here
        // the default behavior is to fallback to autoGenerateObjectStores
        // 1: upgradeService.autoGenerateObjectStores,
        1: Effect.gen(function*() {
          const stores1 = yield* upgradeService.objectStoreNames
          yield* upgradeService.createObjectStore("StoreA") // incase new object stores/indexes are added
          const stores2 = yield* upgradeService.objectStoreNames
          expect(stores1).toEqual([])
          expect(stores2).toEqual(["StoreA"])
          return true
        })
      })
    })
    await runtime.runPromise(Effect.void)
  })
})
