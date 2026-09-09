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

Immutable reads go from the trusted container egress proxy to the repo DO, without a Sandbox DO round trip. Each manifest grant signs the project, repository, blob, actual container identity, and command deadline; it travels in an Authorization header. A grant remains usable for read-only access by that container until its deadline (at most ten minutes), including if the command finishes early. Private reads and every write retain the active workspace capability checks. Invalid or expired grants return 403 without error telemetry.

Writes synchronize after the command, including commands with nonzero exits. Only the workspace's explicit HTTP 204 acknowledges that an individual file is durable; an empty HTTP 200 cannot acknowledge a write. The group of writes is not atomic. A setup failure before the user command starts clears its temporary state after clean teardown. If synchronization or cleanup fails, the native upper, original manifest, and a durable `failure.json` remain under `/workspace/.iterate-workspace-prototype/<scope>` and the next command refuses to run until they are recovered. An abrupt container loss before synchronization can lose pending edits; this is a command-boundary prototype, not continuous write-through storage. The immutable cache and native dependencies are disposable and are rebuilt after container replacement.

The egress proxy materializes each response before sending its status. It retries a read once after 50ms only when Cloudflare marks a transport exception `retryable` and not `overloaded`, recording the retry as a warning and using a fresh DO stub. Writes are never retried by this layer. Persistent transport failures return explicit 502/503 responses and error telemetry. This addresses a live disconnection that otherwise appeared to the container as HTTP 200 with an empty manifest.

This prototype does not add a background service or promise durability for long-running processes. It rejects new source symlinks, special files, and executable-mode changes during synchronization. Existing repo symlinks/executable bits work for reads; deleting or writing binary content into a live collaborative document requires closing its editor first. `.git` remains reserved by workspace policy; use the workspace Git API to commit.

Files are fetched whole and retained in the mount process's memory plus a native cache. Large-file streaming, cache eviction, atomic multi-file commits, continuous editor/sandbox convergence, conflict recovery UX, and arbitrary permission changes are outside this experiment. The repo DO's existing upstream sync still hydrates Git objects; laziness here concerns transport into the sandbox.

## Acceptance evidence

Privileged Docker tests against the stock image proved listing/stat/open transferred zero content, the first read fetched once, repeated reads fetched nothing, and native overlay writes left the lower unchanged. Runner tests covered source creation/deletion, nonzero command exits, 20,000 native files, directory deletion/recreation, file/directory replacement, and no-op rewrites. An injected FUSE startup failure followed by a healthy command also verifies that setup errors do not leave an empty recovery block. Workspace unit tests cover manifest composition and conditional writes, including intervening collaborative edits.

Live preview measurements are recorded below after running the reproducible proof. Transfer counters count file payloads between workspace and sandbox; they exclude manifest JSON, binary bootstrap, and the repo DO's upstream Git traffic. Command durations include mounting and synchronization only where explicitly stated.

### Live preview result (2026-09-09)

Stock basic container, preview-2 OS version `46bf945c-30db-43de-80d6-77a80b2e2024`, fixture `workspace-prototype-1788975652939`:

| Check                                                         | Result                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Enumerate/stat 2,025 files                                    | 0 file payload bytes; 944ms SDK execution including mount/cleanup                |
| Read private DO files, edit/create/delete in sandbox          | Correct DO state; 30B read, 21B written, one deletion                            |
| Re-read a changed DO file in a later command                  | New version observed; next cached read transferred 0B                            |
| Install TypeScript/types and generate 20,000 dependency files | `node_modules` on native ext4; 0 source uploads; compiler worked                 |
| Read 100 distinct 4.2KB files, sequentially                   | Cold: 3.76s / 420,290B; warm: 21.8ms / 0B                                        |
| Offline npm install, two samples per path                     | Native: 6.20s, 7.91s; mounted: 7.02s, 6.69s                                      |
| Destroy container, read uncommitted work in a new container   | Both files recovered from DO; dependencies empty; subsequent Git commit verified |

A controlled comparison on the same container (version `f27cc649`, before the final response guard) measured direct immutable reads at 2.67s/2.65s per 100 cold files versus 5.27s/4.92s through the Sandbox DO. Cached reads took 13–24ms. Thirty mount/cleanup commands all passed, with 624–977ms SDK execution (835ms median). This comparison controls for container placement; individual fresh-container runs vary.

**Cold serial reads still pay one network round trip per file.** The final cold result is 3.76s for 100 files, while cached reads and native dependencies avoid that cost. The final cached `cat` itself took 12ms; its SDK execution took 329ms. Another 100 cold files requested concurrently took 2.30s. The native npm comparison uses a warmed package cache and two samples per path, not a statistical benchmark. Timings exclude fixture/bootstrap and the caller's manifest preparation/RPC overhead.

The final proof exited successfully with zero error events and zero read retries over its settled deployment window. Proxy logs reconcile exactly: 202 immutable fetches and 840,778 bytes (200 benchmark files, package.json, and the deleted source file). The mount separately counts private workspace reads. Trace inspection verifies the direct ContainerProxy → Repo DO route; native RPC capability-lifetime spans may end as `canceled` at info level, separately from operation failures. The compact proof and the controlled comparison are in `evidence.json`.

During development, one RPC disconnection produced an empty HTTP 200 manifest. The final response guard addresses that failure class with complete responses and one observable, read-only retry. Regression tests injected both RPC and response-body disconnections. A stock-image Docker test also injected an empty HTTP 200 write acknowledgement: the runner retained the upper, manifest, and failure record and blocked the next command. A genuine HTTP 204 cleared the pending state.

## Why this shape

The Fable 5.1 xhigh CLI review suggested WebDAV/rclone plus native directory mounts as a smaller starting point. That removes a custom FUSE reader but introduces its own read-cache and conditional-write questions. This experiment keeps the lower deliberately small and delegates mutable filesystem mechanics to the installed overlay implementation. It tests the useful seam before adopting Computer/DOFS or ArtifactFS wholesale.
