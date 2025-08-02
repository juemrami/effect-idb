import { Effect, Layer, pipe } from "effect"
import { indexedDB } from "fake-indexeddb"
import { expect, it } from "vitest"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import { TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"
// Define some custom object stores for your IndexedDB database
interface Contact {
  id?: number
  name?: string
  email: string
  createdAt: string
  friends?: Array<number>
}
class ContactObjectStore extends TaggedIDBObjectStoreService<ContactObjectStore, Contact>()(
  "@app/ContactObjectStore",
  {
    storeConfig: {
      name: "contacts",
      params: {
        keyPath: "id",
        autoIncrement: true
      },
      indexes: [
        { name: "by_name", keyPath: "name" },
        { name: "by_email", keyPath: "email" }
      ]
    },
    makeServiceEffect: (baseService) =>
      Effect.succeed({
        ...baseService,
        findByEmail: (email: string) =>
          pipe(
            baseService.index("by_email"),
            Effect.andThen((emailIndex) => emailIndex.get(email))
          ),
        addAsMutuals: (contactA: Contact, contactB: Contact) =>
          Effect.gen(function*() {
            const keyA = yield* baseService.add(contactA)
            const friends = new Set(contactB.friends)
            friends.add(keyA as number)
            const keyB = yield* baseService.add({ ...contactB, friends: Array.from(friends) })
            yield* baseService.put({ ...contactA, id: keyA, friends: [keyB] })
            return { keyA: keyA as number, keyB: keyB as number }
          })
      })
  }
) {}

interface Note {
  id?: number
  content: string
  createdAt: number
  sharedContacts?: Array<number>
}
class NotesObjectStore extends TaggedIDBObjectStoreService<NotesObjectStore, Note>()(
  "@app/NotesObjectStore",
  {
    storeConfig: {
      name: "notes",
      params: {
        keyPath: "id",
        autoIncrement: true
      },
      indexes: [
        { name: "by_createdAt", keyPath: "createdAt" },
        { name: "by_sharedContacts", keyPath: "sharedContacts", options: { multiEntry: true } }
      ]
    },
    makeServiceEffect: (baseService) => Effect.succeed(baseService)
  }
) {}

// Create a database connection layer
const AppDatabase = IDBDatabaseService.makeTest({
  name: "app-database",
  version: 1,
  // Auto object stores will have any added-removed indexes automatically managed across versions
  autoObjectStores: [ContactObjectStore, NotesObjectStore]
}, indexedDB)

// Now imagine a custom transaction effect that uses both the `NotesObjectStore` and the `ContactObjectStore`
// Note: that when we provide a IDBTransaction to this effect it is treated as a single transaction,
// so it will either fully succeed or fully fail
const createSharedNote = Effect.fn(
  function*(recipientEmails: Array<string>, content: string) {
    // yield any contact store services you want to use in this transaction
    const contactStore = yield* ContactObjectStore
    const notesStore = yield* NotesObjectStore
    const recipientIds = yield* Effect.all(
      recipientEmails.map((email) =>
        pipe(
          contactStore.findByEmail(email),
          Effect.andThen((contact) =>
            contact
              ? Effect.succeed(contact.id as number)
              : contactStore.add({ email, createdAt: new Date().toISOString() })
          )
        )
      )
    )
    return yield* notesStore.add({ content, createdAt: Date.now(), sharedContacts: recipientIds })
  }
)

// Provide the database layer and the custom object stores with appropriate transaction permissions
const program = createSharedNote(["friend1@example.com", "friend2@example.com"], "Hello friends!").pipe(
  Effect.provide(
    Layer.provide(
      Layer.merge(ContactObjectStore.WithReadWrite, NotesObjectStore.WithReadWrite),
      AppDatabase
    )
  )
)

// Run the program
// Note that the db connection resources is scoped to the AppDatabase layer,
// Meaning it will open on program start and be closed after the program exits
it("should create a shared", async () => {
  const notedID = await Effect.runPromise(program)
  expect(notedID).toBeDefined()
})
