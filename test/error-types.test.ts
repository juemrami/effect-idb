import { Console, Effect, Layer, pipe } from "effect"
import { indexedDB } from "fake-indexeddb"
import { expect, it } from "vitest"
import { IndexOpValidExceptionNames } from "../src/errors.js"
import { IDBDatabaseService } from "../src/idbdatabase.js"
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
            // clear up error channel to test next part
            Effect.catchAll((_err) => Effect.die(new Error("Error Channel not empty"))),
            Effect.andThen((emailIndex) => {
              return Effect.all([
                emailIndex.count(email),
                emailIndex.getAllKeys(email),
                emailIndex.get(email)
              ])
            }),
            Effect.tap(Console.log),
            Effect.catchTag("IDBIndexCountError", (_) => {
              return Effect.succeed(null)
            }),
            Effect.catchTag("IDBIndexGetAllKeysError", (_) => {
              return Effect.succeed(null)
            }),
            Effect.catchAll((_err) => {
              // x should be typed as const name for the exception types ie `IndexGetExceptionType`
              const x = _err.cause.name
              // there should be no type error here
              expect(IndexOpValidExceptionNames.get.includes(x)).toBeTruthy()
              return Effect.fail(_err)
            })
          ),
        findByName: (name: string) =>
          pipe(
            baseService.index("by_name"), // This should be fine
            Effect.andThen((nameIndex) => nameIndex.get(name))
          ),
        testError: (x: any) =>
          pipe(
            baseService.index("by_email"),
            // clear up error channel to test next part
            Effect.catchAll((_err) => Effect.die(new Error("Error Channel not empty"))),
            Effect.andThen((emailIndex) => emailIndex.getAll(x)),
            Effect.catchAll((_err) => {
              if (_err.cause instanceof TypeError) return Effect.fail(_err)
              const x = _err.cause.name
              // there should be no type error here
              expect(IndexOpValidExceptionNames.getAll.includes(x)).toBeTruthy()
              return Effect.fail(_err)
            })
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
