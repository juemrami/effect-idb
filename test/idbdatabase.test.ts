import { Effect } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { type IDBDatabaseConfig, IDBDatabaseService, IDBFactoryImplementation } from "../src/idbdatabase.js"
import { createDatabaseTestRuntime } from "../src/runtime.js"

describe("Effect IndexedDB - Runtime and Database Connection", () => {
  const testDbName = `test-db-${Date.now()}`

  beforeEach(() => {
    // fake-indexeddb automatically provides a clean state for each test
  })

  describe("Database Runtime Management", () => {
    it("should create a database runtime successfully", async () => {
      const config: IDBDatabaseConfig = {
        name: testDbName,
        version: 1
      }

      const runtime = createDatabaseTestRuntime(config)

      // Test that the runtime can be created without throwing
      expect(runtime).toBeDefined()

      // Clean up
      await runtime.dispose()
    })

    it("should access database service from within runtime", async () => {
      const config: IDBDatabaseConfig = {
        name: `${testDbName}-service`,
        version: 1
      }

      const runtime = createDatabaseTestRuntime(config)

      const program = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const storeNames = yield* dbService.objectStoreNames
        return storeNames
      })

      const result = await runtime.runPromise(program)

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(0) // New database should have no stores

      await runtime.dispose()
    })

    it("should support multiple runtime connections with different databases", async () => {
      const config1: IDBDatabaseConfig = {
        name: `${testDbName}-db1`,
        version: 1
      }

      const config2: IDBDatabaseConfig = {
        name: `${testDbName}-db2`,
        version: 1
      }

      const runtime1 = createDatabaseTestRuntime(config1)
      const runtime2 = createDatabaseTestRuntime(config2)

      const program = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const storeNames = yield* dbService.objectStoreNames
        return storeNames
      })

      // Both runtimes should work independently

      const program1 = Effect.provide(program, runtime1)
      const program2 = Effect.provide(program, runtime2)

      const [result1, result2] = await Effect.runPromise(
        Effect.all([program1, program2], { concurrency: "unbounded" })
      )

      expect(Array.isArray(result1)).toBe(true)
      expect(Array.isArray(result2)).toBe(true)

      await runtime1.dispose()
      await runtime2.dispose()
    })

    it("should support multiple runtime connections to the same database", async () => {
      const sharedDbName = `${testDbName}-shared`

      const config1: IDBDatabaseConfig = {
        name: sharedDbName,
        version: 1
      }

      const config2: IDBDatabaseConfig = {
        name: sharedDbName,
        version: 1
      }

      const runtime1 = createDatabaseTestRuntime(config1)
      const runtime2 = createDatabaseTestRuntime(config2)

      const program1 = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const dbRef = yield* dbService.use((db) => Effect.succeed(db))
        const storeNames = yield* dbService.objectStoreNames
        return { dbRef, storeNames }
      })

      const program2 = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const dbRef = yield* dbService.use((db) => Effect.succeed(db))
        const storeNames = yield* dbService.objectStoreNames
        return { dbRef, storeNames }
      })

      const task1 = Effect.provide(program1, runtime1)
      const task2 = Effect.provide(program2, runtime2)

      const [result1, result2] = await Effect.runPromise(
        Effect.all([task1, task2], { concurrency: "unbounded" })
      )

      // Verify both connections work
      expect(Array.isArray(result1.storeNames)).toBe(true)
      expect(Array.isArray(result2.storeNames)).toBe(true)

      // Verify they are different database connection objects
      expect(result1.dbRef).not.toBe(result2.dbRef)
      expect(result1.dbRef).toBeDefined()
      expect(result2.dbRef).toBeDefined()

      await runtime1.dispose()
      await runtime2.dispose()
    })

    it("should maintain connection independence when one is closed", async () => {
      const sharedDbName = `${testDbName}-independence`

      const config1: IDBDatabaseConfig = {
        name: sharedDbName,
        version: 1
      }

      const config2: IDBDatabaseConfig = {
        name: sharedDbName,
        version: 1
      }

      const runtime1 = createDatabaseTestRuntime(config1)
      const runtime2 = createDatabaseTestRuntime(config2)

      // First verify both connections work
      const initialProgram = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const storeNames = yield* dbService.objectStoreNames
        return storeNames
      })

      const [result1, result2] = await Effect.runPromise(
        Effect.all([
          Effect.provide(initialProgram, runtime1),
          Effect.provide(initialProgram, runtime2)
        ], { concurrency: "unbounded" })
      )

      expect(Array.isArray(result1)).toBe(true)
      expect(Array.isArray(result2)).toBe(true)

      // Close the first runtime
      await runtime1.dispose()

      // Verify the second connection still works after first is closed
      const afterCloseProgram = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const storeNames = yield* dbService.objectStoreNames
        return storeNames
      })

      const resultAfterClose = await Effect.runPromise(
        Effect.provide(afterCloseProgram, runtime2)
      )

      expect(Array.isArray(resultAfterClose)).toBe(true)

      await runtime2.dispose()
    })
  })
  describe("Database Connection", () => {
    it("should handle database upgrade scenario", async () => {
      let upgradeCallCount = 0

      const config: IDBDatabaseConfig = {
        name: `${testDbName}-upgrade`,
        version: 3,
        onUpgradeNeeded: (db) => ({
          1: Effect.gen(function*() {
            upgradeCallCount++
            // Create a test object store during upgrade
            yield* db.createObjectStore("testStore").pipe(Effect.orDie)
          }),
          2: Effect.gen(function*() {
            upgradeCallCount++
            yield* Effect.void
          }),
          3: Effect.gen(function*() {
            upgradeCallCount++
            yield* Effect.void
          })
        })
      }
      const expectedCalls = 3 // since we are starting from version 1

      const runtime = createDatabaseTestRuntime(config)

      const program = Effect.gen(function*() {
        const dbService = yield* IDBDatabaseService
        const storeNames = yield* dbService.objectStoreNames
        return storeNames
      })

      const result = await runtime.runPromise(program)
      expect(upgradeCallCount).toBe(expectedCalls)
      expect(result).toContain("testStore")

      await runtime.dispose()
    })
  })
  describe("IDBFactoryService", () => {
    it("should provide access to test IndexedDB factory", async () => {
      const program = Effect.gen(function*() {
        const factory = yield* IDBFactoryImplementation
        return factory
      })

      const result = await Effect.runPromise(Effect.provide(program, IDBFactoryImplementation.test))

      expect(result).toBeDefined()
      expect(typeof result.open).toBe("function")
      expect(typeof result.deleteDatabase).toBe("function")
    })
  })
})
