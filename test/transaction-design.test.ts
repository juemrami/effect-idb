import { expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, pipe, Ref, Result } from "effect"
import indexedDB from "fake-indexeddb"
import { IDBTransactionGetObjectStoreError } from "../src/errors.js"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import { TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"
import { IDBTransactionService } from "../src/idbtransaction.js"

type TestCase = {
  readonly id: string
  readonly description: string
  /** other design choice ids this test touches incidentally */
  readonly relatedSpecs: ReadonlyArray<string>
  readonly effect?: Effect.Effect<any, any, any>
}

type DesignChoice = {
  /** stable kebab-case id */
  readonly id: string
  /** one sentence: what the system guarantees */
  readonly guarantee: string
  readonly tests: ReadonlyArray<TestCase>
}

const asyncWork = () => new Promise<1>((resolve) => setTimeout(() => resolve(1), 5))

export const idbTransactionDesignChoices = [
  {
    // One Effect.provide call produces exactly one IDB transaction for its scope.
    id: "one-layer-one-transaction",
    guarantee: "One Effect.provide call produces exactly one IDB transaction for its scope.",
    tests: [
      {
        // scenario: One Effect.provide wraps multiple sequential store ops on the same store.
        // assertion: txnHistory.length === 1 — all ops share a single native transaction.
        id: "same-provision-batched-calls",
        description: "it should batch all store ops within a single provision into one transaction",
        relatedSpecs: [],
        effect: Effect.gen(function*() {
          const db = yield* IDBDatabaseService
          const program = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            yield* store.newWorkout({
              exercises: [{ name: "squat" }],
              closed: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
            yield* store.newWorkout({
              exercises: [{ name: "bench" }],
              closed: false
            })
            yield* store.getAllWorkouts()
          }).pipe(
            Effect.provide(WorkoutStoreService.WithReadWrite)
          )
          yield* program
          const history = yield* Ref.get(db.__transactionHistoryRef)
          expect(history.length).toBe(1) // Should only have one transaction
        })
      },
      {
        // scenario: Two Effect.provide calls run sequentially — no sleep needed between them.
        // assertion: txnHistory.length === 2 — provision boundary alone creates a new transaction.
        id: "sequential-provisions",
        description: "it should open a new transaction for each sequential provision boundary",
        relatedSpecs: ["fresh-by-default"],
        effect: Effect.gen(function*() {
          const db = yield* IDBDatabaseService
          const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
          yield* seedWorkouts // note: seeding data adds a transaction
          const program1 = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            return yield* store.getAllWorkouts()
          }).pipe(
            Effect.provide(WorkoutStoreService.WithReadOnly)
          )
          const program2 = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            return yield* store.getWorkout(1 as IDBValidKey)
          }).pipe(
            Effect.provide(WorkoutStoreService.WithReadOnly)
          )
          const numTransactionsBefore = txnHistory.length
          yield* Effect.all([program1, program2])
          expect(txnHistory.length - numTransactionsBefore).toBe(2) // Should have made two transactions
          return yield* Effect.void
        })
      }
    ]
  },

  {
    // transaction layer helpers always call Layer.fresh internally — they never share a transaction
    // via MemoMap even when the same layer type appears in multiple concurrent programs.
    id: "fresh-by-default",
    guarantee: "Tagged objectStore `With*` layer helpers always produce a new transaction — never share via MemoMap.",
    tests: [
      {
        // scenario: Two programs with identical WithReadWrite provisions run concurrently
        //           via Effect.all with unbounded concurrency.
        // assertion: txnHistory.length === 2 — concurrent provisions do not share a transaction.
        id: "concurrent-unit-provisions-identical-scope",
        description: "it should guarantee each concurrent provision gets its own independent transaction",
        relatedSpecs: ["one-layer-one-transaction"],
        effect: Effect.gen(function*() {
          const db = yield* IDBDatabaseService
          const program1 = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            return yield* store.newWorkout({
              exercises: [{ name: "squat" }],
              closed: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
          })
          const program2 = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            return yield* store.newWorkout({
              exercises: [{ name: "squat" }],
              closed: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
          })
          yield* Effect.all([
            program1.pipe(Effect.provide(WorkoutStoreService.WithReadWrite)),
            program2.pipe(Effect.provide(WorkoutStoreService.WithReadWrite))
          ], { concurrency: "unbounded" })
          const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
          expect(txnHistory.length).toBe(2) // Should have two transactions
          expect(Object.is(txnHistory[0], txnHistory[1])).toBe(false) // Should be distinct transactions

          yield* Effect.all([
            program1.pipe(
              Effect.provide(Layer.provide(WorkoutStoreService.layerNoTransaction, IDBTransactionService.ReadWrite))
            ),
            program2.pipe(
              Effect.provide(Layer.provide(WorkoutStoreService.layerNoTransaction, IDBTransactionService.ReadWrite))
            )
          ], { concurrency: "unbounded" })
          expect(txnHistory.length).toBe(4) // Should have four transactions total — two more from the transaction layer provisions
          expect(Object.is(txnHistory[2], txnHistory[3])).toBe(false) // Should be distinct transactions

          return yield* Effect.void
        })
      }
    ]
  },

  {
    // Any macrotask boundary after the first store op commits the native IDB transaction.
    // ie Effect.sleep and Effect.fork -- both cross a macrotask via the scheduler (setTimeout).
    // After the commit, the transaction handle is dead and further store ops must fail.
    id: "macrotask-gap-kills-transaction",
    guarantee: "Any macrotask boundary after the first store op commits the transaction and makes it unusable.",
    tests: [
      {
        // scenario: One Effect.provide wraps store ops with async work in the middle,
        //           after the first op has already opened the transaction.
        // assertion: program fails with a typed IDBTransactionError
        id: "transaction-with-async-gap",
        description: "it should fail with a typed error when a store op follows an async boundary mid-transaction",
        relatedSpecs: ["dead-transaction-typed-error"],
        effect: Effect.gen(function*() {
          const program = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            const key1 = yield* store.newWorkout()
            const key2 = yield* store.newWorkout()
            yield* store.getAllWorkouts()
            yield* Effect.promise(asyncWork) // cross a macrotask boundary after opening the transaction
            // later work occurs in the next macrotask
            yield* store.deleteWorkout({ id: key1 } as StoredWorkout)
            yield* store.updateWorkout({
              id: key2 as number,
              exercises: [{ name: "updated" }],
              closed: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
            return [yield* store.getWorkout(key2)]
          }).pipe(
            Effect.provide(WorkoutStoreService.WithReadWrite)
          )
          const result = yield* Effect.result(program)
          expect(Result.isFailure(result)).toBe(true)
          expect(yield* Result.getFailure(result).asEffect()).toBeInstanceOf(IDBTransactionGetObjectStoreError)
        })
      },
      {
        // Effect.fork dispatches the child fiber via the scheduler (scheduleTask → setTimeout in browsers).
        // The IDB transaction is committed before the forked fiber runs.
        // Less obvious footgun because code doesn't look async at the call site.
        // scenario: Effect.fork is called after the first store op inside a single provision.
        // assertion: forked fiber's store op fails with a typed error — transaction is dead after fork.
        id: "fork-inside-transaction-scope",
        description:
          "it should fail with a typed error when a forked fiber attempts a store op after the fork boundary",
        relatedSpecs: ["macrotask-gap-kills-transaction"],
        effect: Effect.gen(function*() {
          const program = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            const key = yield* store.newWorkout()
            // forking is always async even when the work is sync
            const fiber = yield* Effect.forkChild(Effect.sync(() => key))
            yield* Exit.match(yield* Fiber.await(fiber), {
              onSuccess: (id) => store.deleteWorkout({ id } as StoredWorkout),
              onFailure: (error) => Effect.sync(() => expect(error).toBeUndefined())
            })
          }).pipe(
            Effect.provide(WorkoutStoreService.WithReadWrite)
          )
          const result = yield* Effect.result(program)
          expect(Result.isFailure(result)).toBe(true)
          expect(yield* Result.getFailure(result).asEffect()).toBeInstanceOf(IDBTransactionGetObjectStoreError)
        })
      }
    ]
  },
  {
    // The native IDB transaction is not requested from the database until the first object store
    // method is called. Async work before that point does not touch the transaction and is safe.
    id: "lazy-open",
    guarantee: "The native IDB transaction is not opened until the first store op — async work before that is safe.",
    tests: [
      {
        id: "lazy-open-async-before-first-op",
        description:
          "it should allow async work inside a provision scope before the first store op without committing the transaction",
        relatedSpecs: ["macrotask-gap-kills-transaction"],
        effect: Effect.gen(function*() {
          const program = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            const x = yield* Effect.promise(asyncWork) // async work before the transaction opens
            yield* store.newWorkout({
              id: x
            }) // first store op opens the transaction
            yield* store.newWorkout({
              exercises: [{ name: "squat" }],
              closed: false,
              createdAt: Date.now(),
              updatedAt: Date.now()
            })
            return (yield* store.getAllWorkouts()).length
          }).pipe(Effect.provide(WorkoutStoreService.WithReadWrite))
          expect(yield* program).toBe(2)
        })
      }
    ]
  },
  {
    // The native db.transaction() call receives store names inferred from which object store
    // layers were composed — not from a string list passed by the caller.
    // Overlapping-scope test is the primary evidence: two concurrent provisions with different
    // store combinations should produce two transactions with different scope arrays.
    id: "scope-from-layer-composition",
    guarantee: "The native transaction scope is inferred from which object store layers are provided.",
    tests: [
      {
        // scenario: effectA provides WorkoutStore only; effectB provides WorkoutStore + ContactStore.
        //           both run concurrently via Effect.all.
        // assertion: txnHistory has 2 entries; match each by storeNames
        id: "concurrent-provisions-overlapping-scopes",
        description:
          "it should scope each transaction to only the stores present in that provision's layer composition",
        relatedSpecs: ["fresh-by-default"],
        effect: Effect.gen(function*() {
          const db = yield* IDBDatabaseService
          yield* seedContacts
          yield* seedWorkouts
          // create overlapping provisions with different scopes
          const provisionA = WorkoutStoreService.WithReadOnly
          const provisionB = Layer.provideMerge(ContactObjectStore.layerNoTransaction, WorkoutStoreService.WithReadOnly)
          const effectA = Effect.gen(function*() {
            const workoutStore = yield* WorkoutStoreService
            yield* workoutStore.getWorkout(1 as IDBValidKey)
          }).pipe(Effect.provide(provisionA))

          const effectB = Effect.gen(function*() {
            const workoutStore = yield* WorkoutStoreService
            const contactStore = yield* ContactObjectStore
            yield* workoutStore.getAllWorkouts()
            yield* contactStore.getAll()
          }).pipe(Effect.provide(provisionB))

          const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
          const numTransactionsBefore = txnHistory.length
          yield* Effect.all([effectA, effectB], { concurrency: "unbounded" })
          const numTransactionsUsed = txnHistory.length - numTransactionsBefore
          expect(numTransactionsUsed).toBe(2) // Should have made two transactions
          const [transaction1, transaction2] = txnHistory.slice(-2)
          if (transaction1.storeNames.length === 1) {
            expect(transaction1.storeNames).toEqual(["workouts"])
            expect(transaction2.storeNames).toEqual(["workouts", "contacts"])
          } else {
            expect(transaction1.storeNames).toEqual(["workouts"])
            expect(transaction2.storeNames).toEqual(["workouts", "contacts"])
          }
        })
      }
    ]
  },

  {
    // When an inner sub-program calls Effect.provide with its own fresh layer while an outer
    // program already has a transaction layer in scope, the inner provision gets a new transaction.
    // It does not inherit or reuse the outer one.
    id: "nested-provision-own-transaction",
    guarantee: "An inner Effect.provide with its own fresh layer gets a separate transaction, not the outer one.",
    tests: [
      {
        // scenario: outer program provides a transaction layer; inner sub-program also provides
        //           its own fresh layer for the same store.
        // assertion: txnHistory.length === 2 — inner provision does not reuse the outer transaction.
        id: "nested-provision-own-transaction",
        description:
          "it should guarantee a nested fresh provision opens its own transaction rather than inheriting the outer one",
        relatedSpecs: ["fresh-by-default"],
        effect: Effect.gen(function*() {
          const outerProvision = WorkoutStoreService.WithReadWrite
          const innerProvision = WorkoutStoreService.WithReadWrite
          const program = Effect.gen(function*() {
            const store = yield* WorkoutStoreService
            yield* store.getAllWorkouts()
            return yield* Effect.gen(function*() {
              const store = yield* WorkoutStoreService
              return yield* store.newWorkout()
            }).pipe(Effect.provide(innerProvision))
          }).pipe(Effect.provide(outerProvision))
          const db = yield* IDBDatabaseService
          const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
          const numTransactionsBefore = txnHistory.length
          yield* program
          const numTransactionsUsed = txnHistory.length - numTransactionsBefore
          expect(numTransactionsUsed).toBe(2) // Should have made two transactions
        })
      }
    ]
  }
] as const satisfies ReadonlyArray<DesignChoice>

type StoredWorkout = {
  id?: number
  exercises: Array<unknown>
  closed: boolean
  createdAt: number
  updatedAt: number
}

class WorkoutStoreService extends TaggedIDBObjectStoreService<WorkoutStoreService, StoredWorkout>()(
  "WorkoutStoreService",
  {
    storeConfig: {
      name: "workouts",
      params: {
        keyPath: "id",
        autoIncrement: true
      },
      indexes: []
    },
    makeServiceEffect: (baseService) =>
      Effect.succeed({
        getAllWorkouts: () => baseService.getAll<StoredWorkout>(),
        getWorkout: (key: IDBValidKey) => baseService.get<StoredWorkout>(key),
        newWorkout: (overrides: Partial<StoredWorkout> = {}) =>
          baseService.add({
            exercises: [],
            closed: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...overrides
          }),
        updateWorkout: (workout: StoredWorkout) => baseService.put(workout),
        deleteWorkout: (workout: StoredWorkout) => baseService.delete(workout.id as number)
      })
  }
) {}

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
const seedContacts = Effect.gen(function*() {
  const contactStore = yield* ContactObjectStore
  yield* contactStore.addAsMutuals(
    { name: "Alice", email: "alice@example.com", createdAt: new Date().toISOString() },
    { name: "Bob", email: "bob@example.com", createdAt: new Date().toISOString() }
  )
  yield* contactStore.add({ name: "Charlie", email: "charlie@example.com", createdAt: new Date().toISOString() })
  yield* contactStore.add({ name: "Diana", email: "diana@example.com", createdAt: new Date().toISOString() })
  yield* contactStore.add({ name: "Eve", email: "eve@example.com", createdAt: new Date().toISOString() })
}).pipe(Effect.provide(ContactObjectStore.WithReadWrite))
const seedWorkouts = Effect.gen(function*() {
  const workoutStore = yield* WorkoutStoreService
  const exercises = ["squat", "bench", "deadlift", "rows", "pull-ups", "dips"]
  for (let i = 0; i < exercises.length; i++) {
    const name = exercises[i]
    yield* workoutStore.newWorkout({
      exercises: [{ name }],
      closed: i < exercises.length - 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
}).pipe(Effect.provide(WorkoutStoreService.WithReadWrite))
const provideDatabase = (name: string) =>
  Effect.provide(IDBDatabaseService.makeTest({
    name,
    version: 1,
    autoObjectStores: [WorkoutStoreService, ContactObjectStore]
  }, indexedDB))
const testProgram = Effect.gen(function*() {
  const testsDir = idbTransactionDesignChoices.map((choice) => choice.tests).flat()
  const getTest = (t: typeof testsDir[number]): Effect.Effect<any, any, any> | null => "effect" in t ? t.effect : null
  const testSuite = pipe(
    Effect.succeed(void 0),
    Effect.andThen((_dbService) =>
      Effect.all(
        testsDir.map((tCase) =>
          Effect.sync(() =>
            pipe(
              [getTest(tCase), `${tCase.id}: ${tCase.description}`] as const,
              ([match, description]) =>
                match === null
                  ? it.skip(description)
                  : it.effect(
                    description,
                    () => match.pipe(provideDatabase(`test-db-${description}`)),
                    1000
                  )
            )
          )
        )
      )
    )
    // provideDatabase
  )
  yield* testSuite
})
await Effect.runPromise(testProgram)
