import { Effect, Ref } from "effect"
import { describe, expect, it } from "vitest"
import { IDBDatabaseService } from "../../src/idbdatabase.js"
import type { IDBObjectStoreConfig } from "../../src/idbobjectstore.js"
import { TaggedIDBObjectStoreService } from "../../src/idbobjectstore.js"
import { createDatabaseTestRuntime } from "../runtime.js"

type Workout = {
  id?: number
  closed: boolean
  exercises: Array<{ name: string }>
  createdAt: number
  updatedAt: number
}

class WorkoutStore extends TaggedIDBObjectStoreService<WorkoutStore, Workout>()(
  "WorkoutStore",
  {
    storeConfig: {
      name: "workouts",
      params: {
        keyPath: "id",
        autoIncrement: true
      },
      indexes: []
    } satisfies IDBObjectStoreConfig,
    makeServiceEffect: (baseService) =>
      Effect.succeed({
        newWorkout: () =>
          baseService.add({
            closed: false,
            exercises: [{ name: "Bench Press" }],
            createdAt: Date.now(),
            updatedAt: Date.now()
          }),
        getWorkout: (key: number) => baseService.get<Workout>(key),
        getAllWorkouts: () => baseService.getAll<Workout>(),
        closeWorkout: (workout: Workout) =>
          baseService.put({
            ...workout,
            closed: true,
            updatedAt: Date.now()
          })
      })
  }
) {}

describe("integration: close flow readonly overlap", () => {
  it("supports refresh-history + get-by-id overlap using the same WithReadOnly layer", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-read-race",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const workoutId = await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return (yield* store.newWorkout()) as number
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          const existing = yield* store.getWorkout(workoutId)
          if (!existing) return
          yield* store.closeWorkout(existing)
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      const safeGetAllWorkouts = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      const safeGetWorkoutById = (id: number) =>
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return yield* store.getWorkout(id)
        }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      for (let attempt = 0; attempt < 25; attempt++) {
        const refreshHistory = runtime.runPromiseExit(safeGetAllWorkouts)

        await new Promise<void>((resolve) => setTimeout(resolve, 0))

        const getDetails = runtime.runPromise(safeGetWorkoutById(workoutId))

        const [historyExit, details] = await Promise.all([refreshHistory, getDetails])

        expect(historyExit._tag).toBe("Success")
        expect(details?.id).toBe(workoutId)
        expect(details?.closed).toBe(true)
      }
    } finally {
      await runtime.dispose()
    }
  })

  it("supports overlap between WithReadWrite and WithReadOnly without transaction inactive errors", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-rw-ro-overlap",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const workoutId = await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return (yield* store.newWorkout()) as number
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      const writeCloseWorkout = (id: number) =>
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          const existing = yield* store.getWorkout(id)
          if (!existing) return null
          yield* store.closeWorkout(existing)
          return id
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))

      const readWorkout = (id: number) =>
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return yield* store.getWorkout(id)
        }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      for (let attempt = 0; attempt < 25; attempt++) {
        const write = runtime.runPromise(writeCloseWorkout(workoutId))

        await new Promise<void>((resolve) => setTimeout(resolve, 0))

        const read = runtime.runPromise(readWorkout(workoutId))

        const [writeResult, readResult] = await Promise.allSettled([write, read])

        expect(writeResult.status).toBe("fulfilled")
        expect(readResult.status).toBe("fulfilled")

        if (readResult.status === "fulfilled") {
          expect(readResult.value?.id).toBe(workoutId)
          expect(readResult.value?.closed).toBe(true)
        }
      }
    } finally {
      await runtime.dispose()
    }
  })

  it("supports fire-and-forget refresh followed by awaited details read", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-fire-and-forget",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const workoutId = await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return (yield* store.newWorkout()) as number
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          const existing = yield* store.getWorkout(workoutId)
          if (!existing) return
          yield* store.closeWorkout(existing)
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      const safeGetAllWorkouts = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      const safeGetWorkoutById = (id: number) =>
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          return yield* store.getWorkout(id)
        }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      for (let attempt = 0; attempt < 25; attempt++) {
        const refreshHistoryExit = runtime.runPromiseExit(safeGetAllWorkouts)

        await new Promise<void>((resolve) => setTimeout(resolve, 0))

        const details = await runtime.runPromise(safeGetWorkoutById(workoutId))
        expect(details?.id).toBe(workoutId)
        expect(details?.closed).toBe(true)

        const refreshExit = await refreshHistoryExit
        expect(refreshExit._tag).toBe("Success")
      }
    } finally {
      await runtime.dispose()
    }
  })

  it("shares transactions in explicit scope but isolates separate top-level runtime calls", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-transaction-sharing-contract",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const clearHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        yield* Ref.set(db.__transactionHistoryRef, [])
      })

      const readHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        return yield* Ref.get(db.__transactionHistoryRef)
      })

      await runtime.runPromise(clearHistory)

      const singleScopeProgram = Effect.gen(function*() {
        const store = yield* WorkoutStore
        yield* store.newWorkout()
        yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadWrite))

      await runtime.runPromise(singleScopeProgram)

      const singleScopeHistory = await runtime.runPromise(readHistory)
      expect(singleScopeHistory.length).toBe(1)

      await runtime.runPromise(clearHistory)

      const addOne = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.newWorkout()
      }).pipe(Effect.provide(WorkoutStore.WithReadWrite))

      const readAll = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      await runtime.runPromise(addOne)
      await runtime.runPromise(readAll)

      const splitCallHistory = await runtime.runPromise(readHistory)
      expect(splitCallHistory.length).toBe(2)
      expect(splitCallHistory[0].mode).toBe("readwrite")
      expect(splitCallHistory[1].mode).toBe("readonly")
    } finally {
      await runtime.dispose()
    }
  })

  it("does not implicitly share transaction across concurrent top-level readonly calls", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-no-implicit-ro-sharing",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const clearHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        yield* Ref.set(db.__transactionHistoryRef, [])
      })

      const readHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        return yield* Ref.get(db.__transactionHistoryRef)
      })

      await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          yield* store.newWorkout()
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      await runtime.runPromise(clearHistory)

      const readAllA = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      const readAllB = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithReadOnly))

      const p1 = runtime.runPromise(readAllA)
      const p2 = runtime.runPromise(readAllB)
      await Promise.all([p1, p2])

      const history = await runtime.runPromise(readHistory)
      expect(history.length).toBe(2)
      expect(history.every((h) => h.mode === "readonly")).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it("does not implicitly share transaction across concurrent top-level readwrite calls", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-no-implicit-rw-sharing",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const clearHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        yield* Ref.set(db.__transactionHistoryRef, [])
      })

      const readHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        return yield* Ref.get(db.__transactionHistoryRef)
      })

      await runtime.runPromise(clearHistory)

      const writeA = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.newWorkout()
      }).pipe(Effect.provide(WorkoutStore.WithReadWrite))

      const writeB = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.newWorkout()
      }).pipe(Effect.provide(WorkoutStore.WithReadWrite))

      const p1 = runtime.runPromise(writeA)
      const p2 = runtime.runPromise(writeB)
      await Promise.all([p1, p2])

      const history = await runtime.runPromise(readHistory)
      expect(history.length).toBe(2)
      expect(history.every((h) => h.mode === "readwrite")).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it("isolates concurrent top-level readonly calls when using Layer.fresh", async () => {
    const runtime = createDatabaseTestRuntime({
      name: "close-flow-fresh-ro-isolation",
      version: 1,
      autoObjectStores: [WorkoutStore]
    })

    try {
      const clearHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        yield* Ref.set(db.__transactionHistoryRef, [])
      })

      const readHistory = Effect.gen(function*() {
        const db = yield* IDBDatabaseService
        return yield* Ref.get(db.__transactionHistoryRef)
      })

      await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* WorkoutStore
          yield* store.newWorkout()
        }).pipe(Effect.provide(WorkoutStore.WithReadWrite))
      )

      await runtime.runPromise(clearHistory)

      const readAllA = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithFreshReadOnly))

      const readAllB = Effect.gen(function*() {
        const store = yield* WorkoutStore
        return yield* store.getAllWorkouts()
      }).pipe(Effect.provide(WorkoutStore.WithFreshReadOnly))

      const p1 = runtime.runPromise(readAllA)
      const p2 = runtime.runPromise(readAllB)
      await Promise.all([p1, p2])

      const history = await runtime.runPromise(readHistory)
      expect(history.length).toBe(2)
      expect(history.every((h) => h.mode === "readonly")).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
