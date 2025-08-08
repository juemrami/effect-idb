import { Effect, Layer, pipe } from "effect"
import { indexedDB } from "fake-indexeddb"
import { IDBDatabaseService } from "src/idbdatabase.js"
import { expect, it } from "vitest"
import { TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"

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
    } as const,
    makeServiceEffect: (baseService) => {
      return Effect.succeed({
        ...baseService,
        findByEmail: (email: string) =>
          pipe(
            // @ts-ignore This should type error. only "by_name" | "by_email" should be allowed
            baseService.index(""),
            Effect.catchAll((_err) => baseService.index("by_email")),
            Effect.andThen((emailIndex) => emailIndex.get(email))
          ),
        findByName: (name: string) =>
          pipe(
            baseService.index("by_name"), // This should be fine
            Effect.andThen((nameIndex) => nameIndex.get(name))
          )
      })
    }
  }
) {}

const dbLayer = IDBDatabaseService.makeTest({
  name: "test-db",
  version: 1,
  autoObjectStores: [ContactObjectStore]
}, indexedDB)

it("should validate all indexes exist", async () => {
  const expectedIndexes = ["by_name", "by_email"] as const satisfies Array<string>
  const program = Effect.gen(function*() {
    const contactStore = yield* ContactObjectStore
    for (const indexName of expectedIndexes) {
      yield* contactStore.index(indexName)
    }
    return yield* contactStore.indexNames
  })

  const indexes = await Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.provide(
          ContactObjectStore.WithReadOnly,
          dbLayer
        )
      )
    )
  )

  expect(indexes).toEqual(expect.arrayContaining(expectedIndexes))
})
