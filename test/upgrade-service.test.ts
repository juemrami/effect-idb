import { Console, Effect, Layer } from "effect"
import { indexedDB } from "fake-indexeddb"
import { describe, expect, it } from "vitest"
import { IDBDatabaseOpenError, IDBDatabaseService } from "../src/idbdatabase.js"
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
class ContactObjectStore extends Effect.Service<ContactObjectStore>()(
  "ContactObjectStore",
  {
    dependencies: [IDBObjectStoreService.make(ContactObjectStoreConfig)],
    effect: Effect.gen(function*() {
      return yield* IDBObjectStoreService
    })
  }
) {}

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
class NotesObjectStore extends Effect.Service<NotesObjectStore>()(
  "NotesObjectStore",
  {
    dependencies: [IDBObjectStoreService.make(NotesObjectStoreConfig)],
    effect: Effect.gen(function*() {
      return yield* IDBObjectStoreService
    })
  }
) {}

describe("Database Upgrade Service", () => {
  it("should auto generate new object stores on database upgrade events", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "testDB",
      version: 1,
      // maybe this could be a way to define object stores that will be automatically created when not present
      objectStores: [ContactObjectStoreConfig, NotesObjectStoreConfig],
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
        name: `testDB_migrations`,
        version: Number(version),
        objectStores: [{ ...ContactObjectStoreConfig, indexes: targetSchema }],
        onUpgradeNeeded: (upgradeService) => ({
          1: upgradeService.autoGenerateObjectStores,
          2: upgradeService.autoGenerateObjectStores,
          3: upgradeService.autoGenerateObjectStores,
          4: upgradeService.autoGenerateObjectStores
        })
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
    type Contact = {
      id?: number
      name: string
      email: string
    }
    type Note = {
      id?: number
      title: string
      content: string
      createdAt: Date
    }
    const runtime = createDatabaseTestRuntime({
      name: "upgradeObjectStoreTestDB",
      version: 2,
      objectStores: [ContactObjectStoreConfig, NotesObjectStoreConfig],
      onUpgradeNeeded: (upgradeService) => ({
        1: upgradeService.autoGenerateObjectStores,
        2: Effect.gen(function*() {
          yield* upgradeService.autoGenerateObjectStores // incase new object stores/indexes are added
          const contacts = yield* upgradeService.objectStore(ContactObjectStoreConfig.name)
          const notes = yield* upgradeService.objectStore(NotesObjectStoreConfig.name)
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
  it("should roll back any index schema changes after an upgrade failure", async () => {
    // step 1 declare and object store with an index schema
    const dbLayer = IDBDatabaseService.makeTest({
      name: "upgradeRollbackTestDB",
      version: 2,
      objectStores: [{
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
          const store = yield* upgradeService.useTransaction((upgradeTxn) =>
            Effect.gen(function*() {
              upgradeTxn.objectStore(ContactObjectStoreConfig.name).deleteIndex("createdAt")
              const store = upgradeTxn.objectStore(ContactObjectStoreConfig.name)
              return yield* Effect.succeed(store)
            })
          )
          const indexNames = Array.from(store.indexNames)
          expect(indexNames).not.toContain("createdAt")
          // step 3: cause and error in the upgrade process
          yield* Effect.fail("Simulated upgrade failure")
        })
      })
    }, indexedDB)
    const upgradeFailure = await Effect.runPromise(Effect.flip(
      Effect.gen(function*() {
        yield* Console.log("Running upgrade rollback test...") // this wont be reached. layer will fail on construction
      }).pipe(
        Effect.provide(dbLayer)
      )
    ))
    expect(upgradeFailure).toBeInstanceOf(IDBDatabaseOpenError)
    expect(upgradeFailure.message).toContain("Simulated upgrade failure")
    // step 4: verify the index schema was rolled back to the original state
    const testProgram = Effect.gen(function*() {
      const txn = yield* IDBTransactionService
      const store = yield* txn.use((idbTxn) => Effect.sync(() => idbTxn.objectStore(ContactObjectStoreConfig.name)), {
        storeNames: [ContactObjectStoreConfig.name]
      })
      const indexNames = Array.from(store.indexNames)
      expect(indexNames).toContain("createdAt")
    }).pipe(
      Effect.provide(IDBTransactionService.ReadOnly)
    )
    await Effect.runPromise(testProgram.pipe(Effect.provide(dbLayer)))
  })
})
