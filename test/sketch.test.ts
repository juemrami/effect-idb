import { expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Match, Option, pipe, Ref } from "effect"
import indexedDB from "fake-indexeddb"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import { IDBObjectStoreService, TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"
import { IDBTransactionService } from "../src/idbtransaction.js"

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

type TransactionCase = {
  readonly id: string
  readonly scenario: string
  readonly expectedShape: string
  readonly implies: ReadonlyArray<string>
  readonly collapsesInto?: ReadonlyArray<string>
  readonly test?: Effect.Effect<void, never, never>
}

export const transactionDesignSketch = Effect.succeed(
  {
    model:
      "A layer guarantees a usable transaction for the current provision, but not necessarily the same transaction across future provisions.",
    cases: [
      {
        id: "same-provision-batched-calls",
        scenario: "User wants to share one transaction across multiple same-store calls inside a single Effect.",
        expectedShape: "One provision, one live transaction, multiple store ops may reuse it until the scope ends.",
        implies: [
          "base registry can memoize the transaction only within the live scope",
          "same-scope same-turn calls should not create extra transactions",
          "this is the core case for a scoped transaction helper"
        ],
        collapsesInto: [
          "same-provision-async-gap",
          "single-store-multi-call-write-flow"
        ]
      },
      {
        id: "same-provision-async-gap",
        scenario: "User wants to yield between store calls and keep using the same transaction.",
        expectedShape:
          "Either the transaction is still alive and can be reused, or the API fails fast with a typed error.",
        implies: [
          "this is the main fork in the road for the API",
          "if it must work, you need an explicit long-lived transaction scope",
          "if it cannot work, stale access should surface IDBTransactionGetObjectStoreError"
        ],
        collapsesInto: [
          "reopen-after-refresh",
          "reopen-after-close-flow"
        ]
      },
      {
        id: "reopen-after-refresh",
        scenario: "An atom or consumer refreshes after the prior evaluation already completed.",
        expectedShape: "A new provision should get a new transaction rather than reusing a closed one.",
        implies: [
          "this is the read-atom refresh failure mode from shared-txn-atom.test.ts",
          "if the registry is reusable, it must not keep a dead transaction in place",
          "fresh layers make this case predictable"
        ]
      },
      {
        id: "reopen-after-close-flow",
        scenario: "A write flow closes, then dependent work tries to use the same registry again.",
        expectedShape: "Either reopen transparently or fail with IDBTransactionGetObjectStoreError.",
        implies: [
          "this is the close-flow failure mode in shared-txn-atom.test.ts",
          "it implies the async-gap case if the same registry is reused after commit",
          "if you choose strictness, this becomes the signal that the consumer needs a new provision"
        ]
      },
      {
        id: "sequential-provisions",
        scenario: "Two separate Effect.provide calls happen one after the other.",
        expectedShape: "Two distinct transactions.",
        implies: [
          "this is the easy case once the layer boundary is respected",
          "it should stay true even if the same runtime is reused",
          "it is the baseline expectation for a fresh layer contract"
        ],
        collapsesInto: ["concurrent-unit-provisions-identical-scope"]
      },
      {
        id: "concurrent-unit-provisions-identical-scope",
        scenario: "Two independent provisions are running at the same time.",
        expectedShape: "Two distinct transactions, not one shared registry transaction.",
        implies: [
          "this is the concurrency test currently failing in shared-txn-atom.test.ts",
          "sharing one transaction across concurrent provisions makes the layer harder to reason about",
          "this case should not be inferred from the sequential case; it needs its own guarantee"
        ]
      },
      {
        id: "explicitly-shared-layer-object",
        scenario: "User wants to create a explicitly shared transaction layer object to keep their code cleaner",
        expectedShape: "single transaction for same runtime operations, different for distinct runtimes",
        implies: [
          "operations within a runtime that use the same layer object share the same transaction"
        ]
      },
      {
        id: "multi-store-single-unit",
        scenario: "One effect touches multiple object stores in one logical unit of work.",
        expectedShape:
          "Either a single transaction spanning the stores, or a higher-level transaction effect that explicitly groups them.",
        implies: [
          "this is where a transaction effect API becomes more honest than a store layer API",
          "if you need atomic cross-store work, the layer alone is too coarse",
          "this case is broader than a single TaggedIDBObjectStoreService"
        ]
      },
      {
        id: "concurrent-provisions-overlapping-scopes",
        scenario: "Two effects with overlapping provisions touch the same store concurrently",
        expectedShape: "there should be 2 transactions with different object store scopes",
        implies: []
      },
      {
        id: "parallel-read-only-work",
        scenario: "Concurrent reads use a read-only layer for one or more stores.",
        expectedShape:
          "Separate read transactions may be fine, but they should not leak mutable registry state into each other.",
        implies: [
          "read-only concurrency should not depend on write transaction behavior",
          "if read atoms reuse stale state, that is a separate cache invalidation issue",
          "this case helps distinguish read caching from transaction caching"
        ]
      },
      {
        id: "provisioning-within-a-provisioned-runtime",
        scenario:
          "A running effect with a context of a transaction tries to provide a new transaction to an effect that runs within the same runtime.",
        expectedShape: "The inner provision should get its own transaction, not reuse the outer one.",
        implies: [
          "the inner provision should not accidentally reuse the outer transaction, which could lead to unexpected sharing or premature closure"
        ]
      }
    ] as const satisfies ReadonlyArray<TransactionCase>,
    decisionPoints: [
      {
        question: "Do you want the default layer API to guarantee a live transaction only for the current provision?",
        ifYes: [
          "reopen-after-refresh becomes a new provision concern",
          "reopen-after-close-flow becomes either a new provision or a typed error",
          "concurrent-provisions must not share a single transaction"
        ]
      },
      {
        question: "Do you want async gaps to remain valid within the same transaction scope?",
        ifYes: [
          "you probably need a separate transaction scope helper, not just a cached layer",
          "same-provision-async-gap becomes the primary API to design",
          "the registry must manage lifecycle explicitly instead of pretending the layer is enough"
        ]
      }
    ]
  } as const
)
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
  const testsDir = yield* transactionDesignSketch
  const testMatcher = Match.type<typeof testsDir.cases[number]>().pipe(
    // scenarios
    // 1. User wants to share a transaction across multiple same-store calls.
    Match.when(
      { id: "same-provision-batched-calls" },
      Effect.fn(function*() {
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
    ),
    // 2. User wants multiple transactions across multiple same-store calls.
    Match.when(
      { id: "sequential-provisions" },
      Effect.fn(function*() {
        const db = yield* IDBDatabaseService
        yield* seedWorkouts
        // program 1
        yield* Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.getAllWorkouts()
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadOnly)
        )
        yield* Effect.sleep("1 millis") // simmulate some async work between provisions
        // program 2
        yield* Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.getWorkout(1 as IDBValidKey)
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadOnly)
        )
        const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
        expect(txnHistory.length).toBe(2) // Should have two transactions
        return yield* Effect.void
      })
    ),
    // 2a. same as 2 but concurrent transactions
    Match.when(
      { id: "concurrent-unit-provisions-identical-scope" },
      Effect.fn(function*() {
        const db = yield* IDBDatabaseService
        // two programs each with own transaction provision running concurrently
        const program1 = Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.newWorkout({
            exercises: [{ name: "squat" }],
            closed: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        )
        const program2 = Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.newWorkout({
            exercises: [{ name: "squat" }],
            closed: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        )
        yield* Effect.all([program1, program2], { concurrency: "unbounded" })
        const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
        expect(txnHistory.length).toBe(2) // Should have two transactions
        return yield* Effect.void
      })
    ),
    // 3. User wants to make concurrent calls to effectA which uses uses a ReadOnly layer for storeA & storeB
    //    and effectB which uses a ReadOnly transaction for only storeA
    Match.when(
      { id: "concurrent-provisions-overlapping-scopes" },
      Effect.fn(function*() {
        const db = yield* IDBDatabaseService
        yield* seedContacts
        yield* seedWorkouts
        // create overlapping provisions with different scopes
        const provisionA = WorkoutStoreService.WithReadOnly
        const provisionB = Layer.provideMerge(ContactObjectStore.Default, WorkoutStoreService.WithReadOnly)
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

        yield* Effect.all([effectA, effectB], { concurrency: "unbounded" })
        const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
        expect(txnHistory.length).toBe(2) // Should have two transactions
        expect(txnHistory[0].storeNames).toContainEqual(["workouts"])
        expect(txnHistory[1].storeNames).toContainEqual(["workouts", "contacts"])
      })
    ),
    // 4. User wants to be able to uses a single txn layer and do async operations in between store calls.
    Match.when(
      { id: "same-provision-async-gap" },
      Effect.fn(function*() {
        const db = yield* IDBDatabaseService
        const program = Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          const key1 = yield* store.newWorkout()
          const key2 = yield* store.newWorkout()
          yield* store.getAllWorkouts()
          yield* Effect.sleep("1 millis")
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
        yield* program
        const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
        expect(txnHistory.length).toBe(1) // Should only have one transaction
      })
    ),
    Match.orElse(({ id }) => Effect.logWarning(`No test implemented for case ${id}`))
  )

  const testSuite = pipe(
    // Effect.service(IDBDatabaseService),
    Effect.succeed(void 0),
    Effect.andThen((_dbService) =>
      Effect.all(
        testsDir.cases.map((c) =>
          Effect.sync(() =>
            it.effect(
              c.id,
              () => testMatcher(c).pipe(provideDatabase(`test-db-${c.id}`))
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

const _x = Effect.gen(function*() {
  const db = yield* IDBDatabaseService
  const program1 = Effect.gen(function*() {
    const store = yield* WorkoutStoreService
    yield* store.newWorkout({
      exercises: [{ name: "squat" }],
      closed: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }).pipe(
    // locally provided
    Effect.provide(
      Layer.provide(WorkoutStoreService.Default, IDBTransactionService.ReadWrite)
    )
  )
  const program2 = Effect.gen(function*() {
    const store = yield* WorkoutStoreService
    yield* store.newWorkout({
      exercises: [{ name: "bench press" }],
      closed: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  })
  const test = pipe(
    Effect.all([program1, program2], { concurrency: "unbounded" }),
    Effect.provide(
      Layer.provide(WorkoutStoreService.Default, IDBTransactionService.ReadWrite)
    )
  )
  yield* test
  const txnHistory = yield* Ref.get(db.__transactionHistoryRef)
  if (txnHistory.length !== 2) {
    throw new Error(`Expected 2 transactions, but got ${txnHistory.length}`)
  }
}).pipe(
  Effect.provide(IDBDatabaseService.makeTest({
    name: "random",
    version: 1,
    autoObjectStores: [WorkoutStoreService, ContactObjectStore]
  }, indexedDB))
)
