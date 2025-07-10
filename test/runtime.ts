import { ManagedRuntime } from "effect"
import { indexedDB } from "fake-indexeddb"
import type { IDBDatabaseConfig } from "src/idbdatabase.js"
import { IDBDatabaseService } from "src/idbdatabase.js"

export const createDatabaseTestRuntime = (config: IDBDatabaseConfig) => {
  return ManagedRuntime.make(
    IDBDatabaseService.makeTest(config, indexedDB) // Pass the fake indexedDB instance
  )
}
