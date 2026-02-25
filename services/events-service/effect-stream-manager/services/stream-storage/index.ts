/**
 * StreamStorage - pluggable storage backend for durable streams
 */

// Re-export service definition
export type { StreamStorage } from "./service.ts";
export { StreamStorageManager, StreamStorageError, StreamStorageManagerTypeId } from "./service.ts";
export type { StreamStorageManagerTypeId as StreamStorageManagerTypeIdType } from "./service.ts";

// Re-export layers
export { inMemoryLayer } from "./in-memory.ts";
export { fileSystemLayer } from "./file-system.ts";
export { sqliteLayer } from "./sqlite.ts";
export type { EventRow } from "./sqlite.ts";
