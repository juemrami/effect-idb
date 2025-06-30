import { ManagedRuntime } from "effect";
import { IDBDatabaseService, type IDBDatabaseConfig } from "./idbdatabse.js";

/**
 * Creates an application-level runtime with a IndexedDB connection.
 * @param persist allows for a persistent connection across the runtime's lifetime.
 *
 *
 * The runtime should be created once at application startup and reused
 * throughout the application lifecycle.
 */
export const createDatabaseRuntime = (config: IDBDatabaseConfig) => {
    return ManagedRuntime.make(
        IDBDatabaseService.makeLive(config)
    );
};

export const createDatabaseTestRuntime = (config: IDBDatabaseConfig) => {
    return ManagedRuntime.make(
        IDBDatabaseService.makeTest(config),
    );
}