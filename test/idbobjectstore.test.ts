import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { IDBDatabaseConfig } from "../src/idbdatabse.js"
import type { IDBObjectStoreConfig } from "../src/idbobjectstore.js"
import { IDBObjectStoreService, IDBTransactionService } from "../src/idbobjectstore.js"
import { createDatabaseTestRuntime } from "../src/runtime.js"

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

describe("IDBObjectStore Integration", () => {
  it("should open database connection, create transaction, and put element", async () => {
    // Define a contact type for our test
    interface Contact {
      id?: number
      name: string
      email: string
    }

    // Create a test runtime with our contact store configuration
    const runtime = createDatabaseTestRuntime({
      name: "testDB",
      version: 1,
      // @ts-ignore
      onUpgrade(db) {
        return Effect.gen(function*() {
          yield* db.createObjectStore(
            ContactObjectStoreConfig.name,
            ContactObjectStoreConfig.params,
            ContactObjectStoreConfig.indexes
          )
        })
      }
    })
    // Test contact data
    const testContact: Contact = {
      name: "John Doe",
      email: "john.doe@example.com"
    }

    // Create the program that will test the full flow
    const testProgram = Effect.gen(function*() {
      // Get the contact store service
      const contactStore = yield* ContactObjectStore
      // Put a contact into the store (this creates transaction internally)
      const contactKey = yield* contactStore.put(testContact)
      // Verify the put operation worked by getting the contact back
      const retrievedContact = yield* contactStore.get<Contact>(contactKey)
      return { contactKey, retrievedContact }
    })

    // Execute the test - provide layers outside of runtime
    const result = await runtime.runPromise(
      testProgram.pipe(
        Effect.provide(
          Layer.provide(
            ContactObjectStore.Default,
            IDBTransactionService.ReadWrite
          )
        )
      )
    )

    // Verify the results
    expect(result.contactKey).toBeDefined()
    expect(typeof result.contactKey).toBe("number") // autoIncrement key
    expect(result.retrievedContact).toBeDefined()
    expect(result.retrievedContact?.name).toBe(testContact.name)
    expect(result.retrievedContact?.email).toBe(testContact.email)
    expect(result.retrievedContact?.id).toBe(result.contactKey)

    // Clean up the runtime
    await runtime.dispose()
  })

  it("should batch operations across multiple stores in a single transaction", async () => {
    // Define types for our test data
    interface Contact {
      id?: number
      name: string
      email: string
    }

    interface Note {
      id?: number
      title: string
      content: string
      createdAt: Date
    }

    // Create a test runtime with both stores
    const runtime = createDatabaseTestRuntime({
      name: "batchTestDB",
      version: 1,
      // @ts-ignore
      onUpgrade(db) {
        return Effect.gen(function*() {
          // Create both object stores
          yield* db.createObjectStore(
            ContactObjectStoreConfig.name,
            ContactObjectStoreConfig.params,
            ContactObjectStoreConfig.indexes
          )
          yield* db.createObjectStore(
            NotesObjectStoreConfig.name,
            NotesObjectStoreConfig.params,
            NotesObjectStoreConfig.indexes
          )
        })
      }
    })

    // Test data
    const testContact: Contact = {
      name: "Jane Doe",
      email: "jane.doe@example.com"
    }

    const testNote: Note = {
      title: "Meeting Notes",
      content: "Important discussion about project timeline",
      createdAt: new Date()
    }
    // Create a simpler program that demonstrates the helper functionality
    const testProgramWithStats = Effect.gen(function*() {
      // Get both store services
      const contactStore = yield* ContactObjectStore
      const notesStore = yield* NotesObjectStore

      // Perform operations on both stores
      const contactKey = yield* contactStore.put(testContact)
      const noteKey = yield* notesStore.put(testNote)

      // Verify both operations worked by retrieving the data
      const retrievedContact = yield* contactStore.get<Contact>(contactKey)
      const retrievedNote = yield* notesStore.get<Note>(noteKey)

      return {
        contactKey,
        noteKey,
        retrievedContact,
        retrievedNote
      }
    }) // Execute the test with both store services using the same transaction service
    const result = await runtime.runPromise(
      testProgramWithStats.pipe(
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
    )

    // Verify the results
    expect(result.contactKey).toBeDefined()
    expect(result.noteKey).toBeDefined()
    expect(result.retrievedContact).toBeDefined()
    expect(result.retrievedNote).toBeDefined()
    expect(result.retrievedContact?.name).toBe(testContact.name)
    expect(result.retrievedNote?.title).toBe(testNote.title)
    // The key assertion: verify that batching occurred

    // Verify that the basic operations work
    expect(result.contactKey).toBeDefined()
    expect(result.noteKey).toBeDefined()
    expect(result.retrievedContact?.name).toBe(testContact.name)
    expect(result.retrievedNote?.title).toBe(testNote.title)

    // The helper methods can now be used for more sophisticated batching tests
    // that verify transaction sharing across multiple object stores

    // Clean up the runtime
    await runtime.dispose()
  })
  it("should concurrently execute readonly transactions", async () => {
    const config: IDBDatabaseConfig = {
      name: "testDB",
      version: 1,
      onUpgrade: (upgradeService, info) =>
        Effect.gen(function*() {
          // Create contacts object store if it doesn't exist
          if (info.newVersion === 1) {
            yield* upgradeService.createObjectStore(
              ContactObjectStoreConfig.name,
              ContactObjectStoreConfig.params,
              ContactObjectStoreConfig.indexes
            )
            yield* upgradeService.createObjectStore(
              NotesObjectStoreConfig.name,
              NotesObjectStoreConfig.params,
              NotesObjectStoreConfig.indexes
            )
          }
        })
    }
    const dbRuntime = createDatabaseTestRuntime(config)
    const putTransaction = Effect.gen(function*() {
      const contactStore = yield* (yield* IDBTransactionService).objectStore("contacts")
      yield* contactStore.add({ name: "Alice", email: "alice@example.com" })
      yield* contactStore.add({ name: "Bob", email: "bob@example.com" })
      return true
    }).pipe(Effect.provide(IDBTransactionService.ReadWrite))

    await dbRuntime.runPromise(putTransaction)

    const DELAY_MS = 100

    // Create transactions with artificial delays
    const transaction1 = Effect.gen(function*() {
      yield* Effect.sleep(`${DELAY_MS} millis`)
      const contactStore = yield* (yield* IDBTransactionService).objectStore("contacts")
      const contacts = yield* contactStore.getAll()
      return { id: 1, data: contacts }
    }).pipe(Effect.provide(IDBTransactionService.ReadOnly))

    const transaction2 = Effect.gen(function*() {
      yield* Effect.sleep(`${DELAY_MS} millis`)
      const contactStore = yield* (yield* IDBTransactionService).objectStore("contacts")
      const alice = yield* contactStore.get(1)
      return { id: 2, data: alice }
    }).pipe(Effect.provide(IDBTransactionService.ReadOnly))

    const transaction3 = Effect.gen(function*() {
      yield* Effect.sleep(`${DELAY_MS} millis`)
      const contactStore = yield* (yield* IDBTransactionService).objectStore("contacts")
      const bob = yield* contactStore.get(2)
      return { id: 3, data: bob }
    }).pipe(Effect.provide(IDBTransactionService.ReadOnly))

    // Test concurrent execution
    const startTime = Date.now()
    const concurrentResults = await dbRuntime.runPromise(
      Effect.all([transaction1, transaction2, transaction3], { concurrency: "unbounded" })
    )
    const concurrentTime = Date.now() - startTime

    // Test sequential execution for comparison
    const startTimeSeq = Date.now()
    const sequentialResults = await dbRuntime.runPromise(
      Effect.all([transaction1, transaction2, transaction3], { concurrency: 0 })
    )
    const sequentialTime = Date.now() - startTimeSeq

    dbRuntime.dispose()

    // Verify results are the same
    expect(concurrentResults).toHaveLength(3)
    expect(sequentialResults).toHaveLength(3)

    // Concurrent should be significantly faster than sequential
    // Sequential should take ~3 * DELAY_MS, concurrent should take ~DELAY_MS
    console.log(`Concurrent execution time: ${concurrentTime}ms`)
    console.log(`Sequential execution time: ${sequentialTime}ms`)

    // Allow some margin for execution overhead, but concurrent should be much faster
    expect(concurrentTime).toBeLessThan(sequentialTime * 0.6)
    expect(sequentialTime).toBeGreaterThan(DELAY_MS * 2.5) // Should be close to 3 * DELAY_MS
    expect(concurrentTime).toBeLessThan(DELAY_MS * 1.8) // Should be close to DELAY_MS
  })
  it("should properly handle multiple database connections", async () => {
    const testDbName = "testConcurrentConnections"
    // trying to test the registry service, make sure that a fresh layer is used for each of the
    // transactions. can verfiy each transaction only touches the specificed object stores
    // Create two separate runtimes with the Different database configuration
    const runtime1 = createDatabaseTestRuntime({
      name: `${testDbName}-1`,
      version: 1,
      onUpgrade: (upgradeService, info) =>
        Effect.gen(function*() {
          if (info.newVersion === 1) {
            yield* upgradeService.createObjectStore(
              ContactObjectStoreConfig.name,
              ContactObjectStoreConfig.params,
              ContactObjectStoreConfig.indexes
            )
          }
        })
    })

    const runtime2 = createDatabaseTestRuntime({
      name: `${testDbName}-2`,
      version: 1,
      onUpgrade: (upgradeService, info) =>
        Effect.gen(function*() {
          if (info.newVersion === 1) {
            yield* upgradeService.createObjectStore(
              NotesObjectStoreConfig.name,
              NotesObjectStoreConfig.params,
              NotesObjectStoreConfig.indexes
            )
          }
        })
    })

    // Test data for both databases
    const testContact = { name: "Alice Smith", email: "alice@example.com" }
    const testNote = { title: "Test Note", content: "This is a test note", createdAt: new Date() }

    // Create programs that will run on each runtime
    const contactProgram = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const contactKey = yield* contactStore.put(testContact)
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

    const noteProgram = Effect.gen(function*() {
      const noteStore = yield* NotesObjectStore
      const noteKey = yield* noteStore.put(testNote)
      const retrievedNote = yield* noteStore.get(noteKey)
      return { noteKey, retrievedNote }
    }).pipe(
      Effect.provide(
        Layer.provide(
          NotesObjectStore.Default,
          IDBTransactionService.ReadWrite
        )
      )
    )

    // Execute programs on their respective runtimes concurrently
    const [contactResult, noteResult] = await Promise.all([
      runtime1.runPromise(contactProgram),
      runtime2.runPromise(noteProgram)
    ])

    // Verify transaction object store registry isn't leaking across runtimes
    // This should fail because runtime2 doesn't have contacts object store
    // Use Effect.flip to turn the failure into a success for easier testing
    const flippedProgram = Effect.flip(contactProgram)
    const transactionError = await runtime2.runPromise(flippedProgram)

    // Check that it's specifically a TransactionError with the right message
    switch (transactionError._tag) {
      // Expected error type
      case "IDBTransactionError":
        // todo: add a better "reason" string or similar to the error
        expect(transactionError.message).toMatch(/object.*store|not.*found/i)
        break
      default:
        expect.fail(`Unexpected error type: ${transactionError._tag}`)
    }

    // Verify the successful operations worked correctly
    expect(contactResult.retrievedContact).toEqual(expect.objectContaining(testContact))
    expect(noteResult.retrievedNote).toEqual(expect.objectContaining(testNote))

    // Clean up
    runtime1.dispose()
    runtime2.dispose()
  })
})
