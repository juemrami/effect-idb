import { Context, Effect, Layer, Ref } from "effect"
import { expect, it } from "vitest"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import type { IDBObjectStoreConfig } from "../src/idbobjectstore.js"
import { IDBObjectStoreService } from "../src/idbobjectstore.js"
import { IDBTransactionService } from "../src/idbtransaction.js"
import { createDatabaseTestRuntime } from "./runtime.js"

const makeStoreEffect = Effect.gen(function*() {
  const baseService = yield* IDBObjectStoreService
  return baseService
})

it("should share a transaction instantiated in multiple places", async () => {
  class ContactObjectStore extends Context.Tag("ContactObjectStore")<
    ContactObjectStore,
    Effect.Effect.Success<typeof makeStoreEffect>
  >() {
    static readonly config: IDBObjectStoreConfig = {
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
    static readonly Default = Layer.effect(ContactObjectStore, makeStoreEffect).pipe(
      Layer.provide(
        Layer.provide(IDBObjectStoreService.make(this.config), IDBTransactionService.ReadWrite)
      )
    )
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
  class NotesObjectStore extends Effect.Service<NotesObjectStore>()(
    "NotesObjectStore",
    {
      dependencies: [
        Layer.provide(
          IDBObjectStoreService.make(NotesObjectStoreConfig),
          IDBTransactionService.ReadWrite // this default any store access to a read-write transaction
        )
      ],
      effect: Effect.gen(function*() {
        return yield* IDBObjectStoreService
      })
    }
  ) {}
  const dbRuntime = createDatabaseTestRuntime({
    name: "sharedTransactionTestDB",
    version: 1,
    objectStores: [ContactObjectStore.config, NotesObjectStoreConfig],
    onUpgradeNeeded: (upgradeService) => ({
      1: upgradeService.autoGenerateObjectStores
    })
  })

  const program = Effect.gen(function*() {
    const contactStore = yield* ContactObjectStore
    const notesStore = yield* NotesObjectStore
    const contact = { name: "Alice", email: "alice@example.com", createdAt: new Date() }
    const note = { title: "Meeting Notes", content: "Discuss project updates", createdAt: new Date() }
    const [contactKey, noteKey] = yield* Effect.all([
      contactStore.add(contact),
      notesStore.add(note)
    ])
    return { contactKey, noteKey }
  }).pipe(Effect.provide(Layer.merge(ContactObjectStore.Default, NotesObjectStore.Default)))
  const result = await dbRuntime.runPromise(program)

  expect(result).toEqual({
    contactKey: 1,
    noteKey: 1
  })
  const checkTransactionHistory = Effect.gen(function*() {
    const dbService = yield* IDBDatabaseService
    return yield* Ref.get(dbService.__transactionHistoryRef)
  })
  const history = await dbRuntime.runPromise(checkTransactionHistory)
  dbRuntime.dispose()
  expect(history.length).toBe(1)
  expect(history[0].storeNames).toEqual(["contacts", "notes"])
  expect(history[0].mode).toBe("readwrite")
})
