import { Console, Effect, Layer, pipe } from "effect"
import { indexedDB } from "fake-indexeddb"
import { expect, it } from "vitest"
import { IDBRequestValidExceptionNames, IndexOpValidExceptionNames, StoreOpValidExceptionNames } from "../src/errors.js"
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
            Effect.catchTag("IDBIndexCountError", (err) => {
              // @ts-expect-error typeof `cause.name` should be ambiguous atp
              IDBRequestValidExceptionNames.includes(err.cause.name)
              if (err.isFromRequest === true) {
                const _ = err
                // no error because cause.name has been narrow
                IDBRequestValidExceptionNames.includes(err.cause.name)
              } else {
                const _ = err
                // same as above
                IndexOpValidExceptionNames.count.includes(err.cause.name)
              }
              return Effect.succeed(null)
            }),
            Effect.catchTag("IDBIndexGetAllKeysError", (_) => {
              return Effect.succeed(null)
            }),
            Effect.catchAll((_err) => {
              // x should be typed as const name for the exception types ie `IndexGetExceptionType`
              let x = _err.cause.name
              if (!_err.isFromRequest) {
                x = _err.cause.name
                expect(IndexOpValidExceptionNames.get.includes(x)).toBeTruthy()
              }
              // there should be no type error here
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
              // there should be no type error here
              if (!_err.isFromRequest) {
                const _x = _err.cause.name
                expect(IndexOpValidExceptionNames.getAll.includes(_x)).toBeTruthy()
              }
              return Effect.fail(_err)
            })
          ),
        testObjectStoreErrorTypes: (x: any) =>
          pipe(
            baseService.index("by_email"),
            Effect.andThen((_) => baseService.clear()),
            Effect.andThen(() => baseService.get(1)),
            Effect.andThen(() => baseService.add(x)),
            Effect.andThen(() => baseService.delete(1)),
            Effect.catchTag("IDBObjectStoreDeleteError", (_err) => {
              if (!_err.isFromRequest) {
                const _x = _err.cause.name
                expect(StoreOpValidExceptionNames.delete.includes(_x)).toBeTruthy()
              }

              return Effect.die(new Error("Error Channel not empty"))
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
