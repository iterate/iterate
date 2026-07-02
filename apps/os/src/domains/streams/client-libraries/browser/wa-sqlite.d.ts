// wa-sqlite's bundled types declare SQLiteAPI/SQLiteVFS ambiently in a way our imports
// can't name, and the OPFSCoopSyncVFS example ships no types at all. We only need to
// describe the one example-module import; everything else is reached through the typed
// `Factory` return and the typed constants subpath.
declare module "@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js" {
  export class OPFSCoopSyncVFS {
    // `module` is the Emscripten instance; the returned VFS is handed straight to
    // sqlite3.vfs_register, so `any` keeps us out of wa-sqlite's unexported VFS types.
    static create(name: string, module: unknown): Promise<any>;
  }
}
