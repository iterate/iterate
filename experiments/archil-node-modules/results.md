# Archil node_modules benchmark

Environment: Fly `lhr` (London) — 4 shared vCPUs, 4 GB RAM
Archil disk: `aws-eu-west-1` (Ireland), backed by Cloudflare R2 (Western Europe)

## Small workload (114 packages, 2232 files)

`pnpm install lodash chalk request commander express`

| Scenario   | pnpm install | Files | Slowdown |
| ---------- | ------------ | ----- | -------- |
| Local disk | 1.6s         | 2232  | 1x       |
| Archil     | 6.5s         | 2232  | **4x**   |

## Medium workload (885 packages, 32,173 files)

`pnpm install @arethetypeswrong/cli @types/node @typescript/native-preview @vitest/ui eslint eslint-plugin-mmkal np pkg-pr-new strip-ansi ts-morph typescript vitest`

| Scenario   | pnpm install   | Files  | Slowdown |
| ---------- | -------------- | ------ | -------- |
| Local disk | 27s            | 32,173 | 1x       |
| Archil     | 1530s (25 min) | 32,173 | **57x**  |

### baseline (medium)

```
[bench:baseline] Started at 2026-03-05T20:32:44Z
[bench:baseline] Running: pnpm install @arethetypeswrong/cli@0.17.3 @types/node@22 ...
[bench:baseline] RESULT pnpm_install=27.045s
[bench:baseline] RESULT nm_files=32173
[bench:baseline] Completed at 2026-03-05T20:33:13Z
```

### archil (medium)

```
[bench:archil] Started at 2026-03-05T20:33:48Z
[bench:archil] Mounted dsk-0000000000005d67 at /mnt/archil
[bench:archil] Running: pnpm install ... (node_modules + store on Archil)
[bench:archil] RESULT pnpm_install=1530.485s
[bench:archil] RESULT nm_files=32173
[bench:archil] Completed at 2026-03-05T21:04:39Z
```

Note: even `find node_modules -type f | wc -l` took ~5 minutes on the Archil mount.
