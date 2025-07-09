import { Context, Effect, Layer } from "effect"
import { describe } from "node:test"
import { expect, it } from "vitest"
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
    Layer.provide(IDBObjectStoreService.make(this.Config))
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
})
