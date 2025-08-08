import { Context, Effect, Layer, Ref } from "effect"
import { describe } from "node:test"
import { expect, it } from "vitest"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import type { IDBObjectStoreConfig } from "../src/idbobjectstore.js"
import { IDBObjectStoreService, TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"
import { IDBTransactionService } from "../src/idbtransaction.js"
import { createDatabaseTestRuntime } from "./runtime.js"

// Tagged Contact store using the new Service factory abstraction
type Contact = {
  id?: IDBValidKey
  name: string
  email: string
  createdAt: string
  friends?: Array<IDBValidKey>
}
class ContactObjectStore extends TaggedIDBObjectStoreService<
  ContactObjectStore,
  Contact
>()(
  "ContactObjectStore",
  {
    storeConfig: {
      name: "contacts",
      params: {
        keyPath: "id",
        autoIncrement: true
      },
      indexes: [
        { name: "name", keyPath: "name" },
        { name: "email", keyPath: "email" }
      ]
    },
    makeServiceEffect: (baseService) =>
      Effect.succeed({
        ...baseService,
        addAsMutuals: (contactA: Contact, contactB: Contact) =>
          Effect.gen(function*() {
            const keyA = yield* baseService.add(contactA)
            const friends = new Set(contactB.friends)
            friends.add(keyA as number)
            const keyB = yield* baseService.add({ ...contactB, friends: Array.from(friends) })
            // Fix: Set the id on the object and don't pass key parameter
            yield* baseService.put({ ...contactA, id: keyA, friends: [keyB] })
            return { keyA: keyA as number, keyB: keyB as number }
          })
      })
  }
) {}

// Tagged notes store using the base IDBObjectStoreService and Context.Tag
type Note = {
  id?: IDBValidKey
  content: string
  createdAt: number
  by?: IDBValidKey
}
const makeCustomNotesStoreEffect = Effect.gen(function*() {
  const baseService = yield* IDBObjectStoreService
  return {
    ...baseService,
    addFriendNote: (note: Note, friendID: IDBValidKey) =>
      baseService.add<Note>({ ...note, createdAt: note.createdAt, by: friendID })
  }
})
class NoteObjectStore extends Context.Tag("NoteObjectStore")<
  NoteObjectStore,
  Effect.Effect.Success<typeof makeCustomNotesStoreEffect>
>() {
  static readonly Config: IDBObjectStoreConfig = {
    name: "notes",
    params: {
      keyPath: "id",
      autoIncrement: true
    },
    indexes: [
      { name: "content", keyPath: "content" },
      { name: "createdAt", keyPath: "createdAt" },
      { name: "by", keyPath: "by" }
    ]
  }
  static readonly Default = Layer.effect(NoteObjectStore, makeCustomNotesStoreEffect).pipe(
    Layer.provide(IDBObjectStoreService.make(this.Config.name))
  )
  static readonly WithReadWrite = Layer.provide(
    NoteObjectStore.Default,
    IDBTransactionService.ReadWrite
  )
  static readonly WithReadOnly = Layer.provide(
    NoteObjectStore.Default,
    IDBTransactionService.ReadOnly
  )
}
describe("User Extended Object Store Service Tests", () => {
  it("should use custom object store", async () => {
    const dbRuntime = createDatabaseTestRuntime({
      name: "customStoreTestDB",
      version: 1,
      autoObjectStores: [ContactObjectStore.Config]
    })
    const program = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      return yield* contactStore.addAsMutuals(
        { name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() },
        { name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() }
      )
    })
    const result = await dbRuntime.runPromise(
      Effect.provide(
        program,
        ContactObjectStore.WithReadWrite
      )
    )
    expect(result).toEqual({
      keyA: 1,
      keyB: 2
    })
    dbRuntime.dispose()
  })
  it("should batch multiple custom transactions", async () => {
    const dbRuntime = createDatabaseTestRuntime({
      name: "customBatchTestDB",
      version: 1,
      autoObjectStores: [ContactObjectStore, NoteObjectStore]
    })
    const program = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const result = yield* contactStore.addAsMutuals(
        { name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() },
        { name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() }
      )
      const noteStore = yield* NoteObjectStore
      yield* noteStore.addFriendNote(
        { content: "Hello Bob!", createdAt: new Date().getTime() },
        result.keyB
      )
      return result
    })
    const result = await dbRuntime.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(ContactObjectStore.Default, NoteObjectStore.Default).pipe(
          Layer.provide(IDBTransactionService.ReadWrite)
        )
      )
    )
    expect(result).toEqual({
      keyA: 1,
      keyB: 2
    })
    dbRuntime.dispose()
  })
  it("should only create a single transaction registry layer for multiple stores with provided transactions", async () => {
    const dbRuntime = createDatabaseTestRuntime({
      name: "singleTransactionRegistryDB",
      version: 1,
      autoObjectStores: [ContactObjectStore.Config, NoteObjectStore.Config]
    })
    const program = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const noteStore = yield* NoteObjectStore
      const { keyA: _, keyB } = yield* contactStore.addAsMutuals(
        { name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() },
        { name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() }
      )
      return yield* noteStore.addFriendNote(
        { content: "Hello Bob!", createdAt: new Date().getTime() },
        keyB
      )
    })
    const _ = await dbRuntime.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(
          ContactObjectStore.WithReadWrite,
          NoteObjectStore.WithReadWrite
        )
      )
    )
    const txns = await dbRuntime.runPromise(Effect.gen(function*() {
      const db = yield* IDBDatabaseService
      return yield* Ref.get(db.__transactionHistoryRef)
    }))
    expect(txns.length).toBe(1) // Should only have one transaction
    expect(txns[0].mode).toBe("readwrite") // Should be readwrite
  })
  it("should treat b2b transaction effects with same scope as two separate db transactions", async () => {
    const dbRuntime = createDatabaseTestRuntime({
      name: "b2bTransactionTestDB",
      version: 1,
      autoObjectStores: [ContactObjectStore.Config, NoteObjectStore.Config]
    })
    const addAlice = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      return yield* contactStore.add({ name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() })
    }).pipe(
      Effect.provide(ContactObjectStore.WithReadWrite)
    )
    const addBob = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      return yield* contactStore.add({ name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() })
    }).pipe(
      Effect.provide(ContactObjectStore.WithReadWrite)
    )
    const _ = await dbRuntime.runPromise(
      Effect.zip(addAlice, addBob)
    )
    const txns = await dbRuntime.runPromise(Effect.gen(function*() {
      const db = yield* IDBDatabaseService
      return yield* Ref.get(db.__transactionHistoryRef)
    }))
    expect(txns.length).toBe(2) // Should have two transactions
    expect(txns[0].mode).toBe("readwrite") // Should be readwrite
    expect(txns[0].storeNames).toContain("contacts") // Should include contacts
    expect(txns[1].mode).toBe("readwrite") // Should be readwrite
    expect(txns[1].storeNames).toContain("contacts") // Should include contacts
  })
  it("should handle Fresh transaction layers as separate transactions", async () => {
    const dbRuntime = createDatabaseTestRuntime({
      name: "freshTransactionTestDB",
      version: 1,
      autoObjectStores: [ContactObjectStore.Config, NoteObjectStore.Config]
    })
    const program = Effect.gen(function*() {
      const contactStore = yield* ContactObjectStore
      const result = yield* contactStore.addAsMutuals(
        { name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() },
        { name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() }
      )
      const noteStore = yield* NoteObjectStore
      yield* noteStore.addFriendNote(
        { content: "Hello Bob!", createdAt: new Date().getTime() },
        result.keyB
      )
      return result
    })
    const _ = await dbRuntime.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(ContactObjectStore.WithFreshReadWrite, NoteObjectStore.WithReadWrite.pipe(Layer.fresh))
      )
    )
    const txns = await dbRuntime.runPromise(Effect.gen(function*() {
      const db = yield* IDBDatabaseService
      return yield* Ref.get(db.__transactionHistoryRef)
    }))
    expect(txns.length).toBe(2) // Should have two transactions
    expect(txns[0].storeNames).not.toContain("notes") // Should only include contacts
    expect(txns[1].storeNames).not.toContain("contacts") // Should only include notes
  })
})
