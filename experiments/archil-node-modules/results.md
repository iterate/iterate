# Archil node_modules benchmark

Generated: 2026-03-05T22:30:27Z

## Fly.io `lhr` (London) — 4 shared vCPUs, 4 GB RAM

| Workload | Files  | Local disk | Archil             | Slowdown |
| -------- | ------ | ---------- | ------------------ | -------- |
| Small    | 2,232  | 1.622s     | 6.507s             | **4x**   |
| Medium   | 32,173 | 27.045s    | 1530.485s (25m30s) | **56x**  |

## MacBook (Docker)

| Workload | Files  | Local disk | Archil | Slowdown |
| -------- | ------ | ---------- | ------ | -------- |
| Small    | 2,232  | 1.497s     | —      | —        |
| Medium   | 32,173 | 20.687s    | —      | —        |

---

## Raw logs

### docker-local-disk-medium-workload

```
[bench:baseline:medium] Started at 2026-03-05T22:27:17Z
[bench:baseline:medium] Running: pnpm install @arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3
[bench:baseline:medium] RESULT pnpm_install=20.687s
[bench:baseline:medium] RESULT nm_files=32173
[bench:baseline:medium] Completed at 2026-03-05T22:27:39Z
```

### docker-local-disk-small-workload

```
[bench:baseline:small] Started at 2026-03-05T22:27:08Z
[bench:baseline:small] Running: pnpm install lodash chalk request commander express
[bench:baseline:small] RESULT pnpm_install=1.497s
[bench:baseline:small] RESULT nm_files=2232
[bench:baseline:small] Completed at 2026-03-05T22:27:11Z
```

### fly-archil-disk-medium-workload

```
[bench:archil:medium] Started at 2026-03-05T20:33:48Z
[bench:archil:medium] Mounted dsk-0000000000005d67 at /mnt/archil
[bench:archil:medium] Running: pnpm install @arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3 (node_modules + store on Archil)
[bench:archil:medium] RESULT pnpm_install=1530.485s
[bench:archil:medium] RESULT nm_files=32173
[bench:archil:medium] Completed at 2026-03-05T21:04:39Z
```

### fly-archil-disk-small-workload

```
[bench:archil:small] Started at 2026-03-05T20:23:07Z
[bench:archil:small] Mounted dsk-0000000000005d67 at /mnt/archil
[bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[bench:archil:small] RESULT pnpm_install=6.507s
[bench:archil:small] RESULT nm_files=2232
[bench:archil:small] Completed at 2026-03-05T20:23:16Z
```

### fly-local-disk-medium-workload

```
[bench:baseline:medium] Started at 2026-03-05T20:32:44Z
[bench:baseline:medium] Running: pnpm install @arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3
[bench:baseline:medium] RESULT pnpm_install=27.045s
[bench:baseline:medium] RESULT nm_files=32173
[bench:baseline:medium] Completed at 2026-03-05T20:33:13Z
```

### fly-local-disk-small-workload

```
[bench:baseline:small] Started at 2026-03-05T20:22:38Z
[bench:baseline:small] Running: pnpm install lodash chalk request commander express
[bench:baseline:small] RESULT pnpm_install=1.622s
[bench:baseline:small] RESULT nm_files=2232
[bench:baseline:small] Completed at 2026-03-05T20:22:41Z
```
