import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, pipe, Ref } from "effect"
import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { indexedDB } from "fake-indexeddb"
import { IDBTransactionGetObjectStoreError } from "../src/errors.js"
import { IDBDatabaseService } from "../src/idbdatabase.js"
import { TaggedIDBObjectStoreService } from "../src/idbobjectstore.js"

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

const deleteDatabase = (name: string) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Deleting ${name} was blocked`))
  })

const makeHarness = (dbName: string) => {
  const testDbLayer = IDBDatabaseService.makeTest({
    name: dbName,
    version: 1,
    autoObjectStores: [WorkoutStoreService.Config]
  }, indexedDB)

  const readOnlyStoreRuntime = Atom.runtime(Layer.provide(
    WorkoutStoreService.WithFreshReadOnly,
    testDbLayer
  ))
  const readWriteStoreRuntime = Atom.runtime(Layer.provide(
    WorkoutStoreService.WithFreshReadWrite,
    testDbLayer
  ))

  const userWorkoutsAtom = readOnlyStoreRuntime.atom(() =>
    Effect.gen(function*() {
      const store = yield* WorkoutStoreService
      return yield* store.getAllWorkouts()
    })
  )

  const userCurrentWorkoutAtom = readOnlyStoreRuntime.atom((get) =>
    Effect.gen(function*() {
      const all = yield* get.result(userWorkoutsAtom)
      const last = all[all.length - 1]
      return last && !last.closed ? last : null
    })
  )

  const closeCurrentWorkoutFn = readWriteStoreRuntime.fn((_: void, ctx) =>
    Effect.gen(function*() {
      const currentWorkout = yield* ctx.result(userCurrentWorkoutAtom)
      const store = yield* WorkoutStoreService

      if (!currentWorkout?.id) {
        return false
      }

      yield* store.updateWorkout({
        ...currentWorkout,
        closed: true,
        updatedAt: currentWorkout.updatedAt + 1
      })

      ctx.refresh(userWorkoutsAtom)
      return true
    })
  )

  const seedWorkout = (overrides: Partial<StoredWorkout> = {}) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* WorkoutStoreService
        return yield* store.newWorkout(overrides)
      }).pipe(
        Effect.provide(Layer.provide(WorkoutStoreService.WithFreshReadWrite, testDbLayer))
      )
    )

  return {
    closeCurrentWorkoutFn,
    readWriteRuntime: readWriteStoreRuntime,
    seedWorkout,
    userCurrentWorkoutAtom,
    userWorkoutsAtom,
    testDbLayer,
    readOnlyStoreRuntime,
    cleanup: () => deleteDatabase(dbName)
  }
}

describe("shared transaction atom reproduction", () => {
  it(
    "reuses a finished transaction after refreshing a read atom",
    async function() {
      const registry = AtomRegistry.make()
      const harness = makeHarness("shared-txn-atom-refresh-repro")
      await harness.seedWorkout({
        id: 1,
        closed: false,
        exercises: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      const release = registry.mount(harness.userWorkoutsAtom)
      try {
        const workouts = AtomRegistry.getResult(registry, harness.userWorkoutsAtom)
        await expect(
          Effect.runPromise(workouts)
        ).resolves.toHaveLength(1)

        await new Promise((resolve) => setImmediate(resolve))

        registry.refresh(harness.userWorkoutsAtom)
        const exit = await Effect.runPromiseExit(AtomRegistry.getResult(registry, harness.userWorkoutsAtom))
        Exit.match(exit, {
          onSuccess: (workouts) => expect(workouts).toHaveLength(1),
          onFailure: (error) => {
            throw error
          }
        })
      } finally {
        release()
        registry.dispose()
        await harness.cleanup()
      }
    }
  )

  it("triggers a finished transaction error when a refresh follows the close flow", async () => {
    const harness = makeHarness("shared-txn-atom-close-flow-repro")
    const registry = AtomRegistry.make()
    await harness.seedWorkout({
      id: 1,
      closed: false,
      exercises: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const releases = [
      registry.mount(harness.userWorkoutsAtom),
      registry.mount(harness.userCurrentWorkoutAtom),
      registry.mount(harness.closeCurrentWorkoutFn)
    ]
    try {
      await expect(
        Effect.runPromise(AtomRegistry.getResult(registry, harness.userCurrentWorkoutAtom))
      ).resolves.toMatchObject({ closed: false })

      registry.set(harness.closeCurrentWorkoutFn, undefined)

      await expect(
        Effect.runPromise(AtomRegistry.getResult(registry, harness.closeCurrentWorkoutFn))
      ).resolves.toBe(true)

      await expect(
        Effect.runPromise(AtomRegistry.getResult(registry, harness.userCurrentWorkoutAtom))
      ).resolves.toMatchObject({ id: 1 })
    } finally {
      for (const release of releases) {
        release()
      }
      registry.dispose()
      await harness.cleanup()
    }
  })

  it("reopens a transaction after yielding instead of reusing the finished tx", async () => {
    const harness = makeHarness("shared-txn-atom-async-repro")
    await harness.seedWorkout({
      id: 1,
      closed: false,
      exercises: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    const asyncAtom = Effect.gen(function*() {
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
      Effect.provide(Layer.provide(
        WorkoutStoreService.WithFreshReadWrite,
        harness.testDbLayer
      ))
    )
    try {
      const exit = await Effect.runPromiseExit(asyncAtom)
      Exit.match(exit, {
        onSuccess: (workouts) => expect(workouts).toHaveLength(1),
        onFailure: (cause) => {
          throw cause.reasons[0]
        }
      })
    } finally {
      await harness.cleanup()
    }
  })

  it.effect("does not share a transaction for multiple *sequential* provisions of the a TaggedObjectStore's WithReadWrite layer", () =>
    Effect.gen(function*() {
      const databaseService = yield* IDBDatabaseService
      const programs = [
        Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          const key = yield* store.newWorkout()
          return yield* store.updateWorkout({
            id: key as number,
            exercises: [{ name: "updated" }],
            closed: true,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        ),
        Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.updateWorkout({
            id: 2 as number,
            exercises: [{ name: "updated" }],
            closed: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        )
      ]
      yield* Effect.all(programs)
      const txnHistory = yield* Ref.get(databaseService.__transactionHistoryRef)
      expect(txnHistory.length).toBe(2)
    }).pipe(
      Effect.provide(IDBDatabaseService.makeTest({
        name: "shared-txn-multiple-provision-sequential",
        version: 1,
        autoObjectStores: [WorkoutStoreService.Config]
      }, indexedDB))
    ))
  it.effect("does not share a transaction for multiple *concurrent* provisions of the a TaggedObjectStore's WithReadWrite layer", () =>
    Effect.gen(function*() {
      const databaseService = yield* IDBDatabaseService
      const programs = [
        Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          return yield* store.updateWorkout({
            id: 1 as number,
            exercises: [{ name: "updated" }],
            closed: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        ),
        Effect.gen(function*() {
          const store = yield* WorkoutStoreService
          yield* store.newWorkout()
        }).pipe(
          Effect.provide(WorkoutStoreService.WithReadWrite)
        )
      ]
      yield* Effect.all(programs, { concurrency: "unbounded" })
      const txnHistory = yield* Ref.get(databaseService.__transactionHistoryRef)
      const numIdbTransactions = txnHistory.length
      expect(numIdbTransactions).toBe(2)
    }).pipe(
      Effect.provide(IDBDatabaseService.makeTest({
        name: "shared-txn-multiple-provision-concurrent",
        version: 1,
        autoObjectStores: [WorkoutStoreService.Config]
      }, indexedDB))
    ))

  it("reopens the transaction after an async yield instead of reusing the closed tx", async () => {
    const harness = makeHarness("shared-txn-atom-async-repro")
    await harness.seedWorkout({
      id: 1,
      closed: false,
      exercises: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    const asyncFlow = Effect.gen(function*() {
      const store = yield* WorkoutStoreService
      yield* store.getAllWorkouts()
      yield* Effect.sleep("1 millis")
      return yield* store.getAllWorkouts()
    }).pipe(
      Effect.provide(
        Layer.provide(
          WorkoutStoreService.WithFreshReadOnly,
          harness.testDbLayer
        )
      )
    )

    await expect(Effect.runPromise(asyncFlow)).resolves.toHaveLength(1)
    await harness.cleanup()
  })
})
