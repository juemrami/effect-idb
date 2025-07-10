import { ManagedRuntime } from "effect"
import { type IDBDatabaseConfig, IDBDatabaseService } from "./idbdatabase.js"
/**
 * Creates an application-level runtime with a IndexedDB connection.
 * Allows for a persistent connection to the IndexedDB database in a runtime not controlled by effect.
 * ie inside of a SPA top level component.
 * The runtime could be created once at application startup and reused
 * throughout the application lifecycle without needing to reconnect to the IndexedDB database.
 */
export const createDatabaseRuntime = (config: IDBDatabaseConfig) => {
  return ManagedRuntime.make(
    IDBDatabaseService.makeLive(config)
  )
}
