# Lazy workspace sandbox prototype

This experiment lets a finite sandbox command work on an existing OS workspace. A metadata-only manifest describes the composed repo base, private files, whiteouts, and live collaborative documents. The sandbox downloads a file only when it reads its contents, caches it by Git blob ID, and uploads changed source files after the command. Explicit native directories such as `node_modules` never enter the DO workspace.

```text
Workspace DO (existing authority)
  ├── repo HEAD + private edits + live collaborative documents
  └── manifest / versioned reads / conditional writes
                      ↕ container-scoped egress
Sandbox
  ├── read-only FUSE lower: metadata + on-demand content cache
  ├── native writable overlay: changed source files
  └── native bind mounts: node_modules, build caches, generated output
```

The implementation reuses the stock `cloudflare/sandbox:0.12.3` image's `fuse-overlayfs`. The Go program supplies only a read-only lower filesystem; the native overlay implements writes and POSIX behavior during the command. There is no custom image, directory watcher, Git checkout, or new storage authority. The CLI builds and uploads the binary and runner once per content version.

## Try it

Requires Go and the normal repo/Doppler setup. From `apps/os`:

```sh
doppler run --config preview_2 -- pnpm cli workspace-sandbox-prototype proof
```

The proof creates an isolated project and repository with 2,000 unread files, checks uncommitted source edits in both directions, installs real dependencies, creates 20,000 native files, compares cold/cached reads and native installs, destroys the container, recovers source changes in another container, and commits through `workspace.git.commit`. Both containers are destroyed on completion; the fixture project remains available for inspection.

To use an existing workspace and already-created sandbox:

```sh
doppler run --config preview_2 -- pnpm cli workspace-sandbox-prototype run \
  --project my-project --sandbox /sandboxes/dev \
  --workspace-path /workspaces/dev --under /repos/my-repo \
  --local-directories node_modules --timeout-ms 180000 \
  --command 'npm install && npm test'
```

Only explicitly selected native directories bypass persistence. The mount refuses a native directory that would hide an existing workspace file. Include other generated directories explicitly when appropriate; untracked source files are otherwise preserved.

## Consistency and recovery

A command sees the manifest captured at its start. Committed files read their exact immutable Git blob directly from the repo DO; private/live files check that the workspace still contains that version. If a blob was pruned or a private file changed, a cache miss produces a conflict instead of returning mixed-version bytes. Source writes compare their original version with current DO state, including the collaborative editor's write queue. A conflicting editor write survives. Repeated writes with the same resulting content are idempotent.

Writes synchronize after the command, including commands with nonzero exits. Each acknowledgement means that individual file is durable in the workspace. The group of writes is not atomic. If synchronization fails, the native upper and original manifest remain under `/workspace/.iterate-workspace-prototype/<scope>` and the next command refuses to run until they are recovered. An abrupt container loss before synchronization can lose pending edits; this is a command-boundary prototype, not continuous write-through storage. The immutable cache and native dependencies are disposable and are rebuilt after container replacement.

This prototype does not add a background service or promise durability for long-running processes. It rejects new source symlinks, special files, and executable-mode changes during synchronization. Existing repo symlinks/executable bits work for reads; deleting or writing binary content into a live collaborative document requires closing its editor first. `.git` remains reserved by workspace policy; use the workspace Git API to commit.

Files are fetched whole and retained in the mount process's memory plus a native cache. Large-file streaming, cache eviction, atomic multi-file commits, continuous editor/sandbox convergence, conflict recovery UX, and arbitrary permission changes are outside this experiment. The repo DO's existing upstream sync still hydrates Git objects; laziness here concerns transport into the sandbox.

## Acceptance evidence

Privileged Docker tests against the stock image proved listing/stat/open transferred zero content, the first read fetched once, repeated reads fetched nothing, and native overlay writes left the lower unchanged. Runner tests covered source creation/deletion, nonzero command exits, 20,000 native files, directory deletion/recreation, file/directory replacement, and no-op rewrites. Workspace unit tests cover manifest composition and conditional writes, including intervening collaborative edits.

Live preview measurements are recorded below after running the reproducible proof. Transfer counters count file payloads between workspace and sandbox; they exclude manifest JSON, binary bootstrap, and the repo DO's upstream Git traffic. Command durations include mounting and synchronization only where explicitly stated.

### Live preview result (2026-09-09)

Stock basic container, preview-2 OS version `5518a1ef-7bb3-4025-b27a-99c80fbf5f68`, fixture `workspace-prototype-1788972259663`:

| Check                                                         | Result                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Enumerate/stat 2,025 files                                    | 0 file payload bytes; 2.08s SDK execution including mount/cleanup                |
| Read private DO files, edit/create/delete in sandbox          | Correct DO state; 30B read, 21B written, one deletion                            |
| Re-read a changed DO file in a later command                  | New version observed; next cached read transferred 0B                            |
| Install TypeScript/types and generate 20,000 dependency files | `node_modules` on native ext4; 0 source uploads; compiler worked                 |
| Read 100 distinct 4.2KB files, sequentially                   | Cold: 6.47s / 420,290B; warm: 30.5ms / 0B                                        |
| Offline npm install, two samples per path                     | Native: 6.20s, 8.10s; mounted: 6.90s, 6.90s                                      |
| Destroy container, read uncommitted work in a new container   | Both files recovered from DO; dependencies empty; subsequent Git commit verified |

Direct immutable reads bypass repeated workspace lifecycle/routing checks and base64 encoding. The first implementation took 16.54s for the same 100-file cold-read case; direct blob reads took 6.47s. **Cold serial reads still pay network latency** (about 65ms per file here), so the fifth goal is only partially demonstrated: cached reads and native dependencies are fast, while first-read latency remains material. Mounting/cleanup also adds per-command overhead (the cached `cat` itself took 32ms; its SDK execution took 391ms). The native comparison uses a warmed package cache and two samples, not a statistical benchmark. Timings exclude fixture/bootstrap and the caller's manifest preparation/RPC overhead.

The final proof exited successfully. Cloudflare error-level telemetry was empty over the proof window after fixing CLI close-handshake teardown. Trace inspection verified successful source reads/writes and also exposed native RPC capability-lifetime spans marked `canceled`/`span_not_ended` at info level; these are recorded separately from operation failures, not counted as successful durable writes. The compact proof is in `evidence.json`.

## Why this shape

The Fable 5.1 xhigh CLI review suggested WebDAV/rclone plus native directory mounts as a smaller starting point. That removes a custom FUSE reader but introduces its own read-cache and conditional-write questions. This experiment keeps the lower deliberately small and delegates mutable filesystem mechanics to the installed overlay implementation. It tests the useful seam before adopting Computer/DOFS or ArtifactFS wholesale.
