# Archil node_modules benchmark

Generated: 2026-03-06T11:45:17Z

## Fly.io `lhr` (London) — 4 shared vCPUs, 4 GB RAM

| Workload | Files  | Local disk | Archil             | Slowdown |
| -------- | ------ | ---------- | ------------------ | -------- |
| Small    | 2,232  | 1.622s     | 6.425s             | **3x**   |
| Medium   | 32,173 | 27.045s    | 1530.485s (25m30s) | **56x**  |

## MacBook (Docker)

| Workload | Files  | Local disk | Archil             | Slowdown |
| -------- | ------ | ---------- | ------------------ | -------- |
| Small    | 2,232  | 1.497s     | 5.950s             | **3x**   |
| Medium   | 32,173 | 20.687s    | 5381.539s (89m41s) | **260x** |

## Tuning options — Fly.io `lhr`, Small workload, Archil

| Variant         | pnpm install | vs Control |
| --------------- | ------------ | ---------- |
| control         | 6.425s       | —          |
| eatmydata       | 5.529s       | -13%       |
| nconnect4       | 6.530s       | +1%        |
| writeback-cache | 7.276s       | +13%       |

---

## Raw logs

### docker-archil-disk-medium-workload

```
[bench:archil:medium] Started at 2026-03-05T22:55:19Z
[bench:archil:medium] Mounted dsk-0000000000005d30 at /mnt/archil
[bench:archil:medium] Running: pnpm install @arethetypeswrong/cli@0.17.3 @types/node@22 @typescript/native-preview@7.0.0-dev.20250527.1 @vitest/ui@3 eslint@8.57 eslint-plugin-mmkal@0.9.0 np@10 pkg-pr-new@0.0.39 strip-ansi@7.1.0 ts-morph@23.0.0 typescript@5.9.2 vitest@3 (node_modules + store on Archil)
[bench:archil:medium] RESULT pnpm_install=5381.539s
[bench:archil:medium] RESULT nm_files=32173
[bench:archil:medium] Completed at 2026-03-06T00:40:44Z
```

### docker-archil-disk-small-workload

```
[bench:archil:small] Started at 2026-03-05T22:43:48Z
[bench:archil:small] Mounted dsk-0000000000005d30 at /mnt/archil
[bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[bench:archil:small] RESULT pnpm_install=5.950s
[bench:archil:small] RESULT nm_files=2232
[bench:archil:small] Completed at 2026-03-05T22:44:13Z
```

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

### fly-archil-disk-medium-workload-eatmydata

```
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT pnpm_install=1433.330s
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT cpu_peak=66.0%
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT cpu_avg=4.1%
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT mem_peak=1971MB
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT mem_avg=1620MB
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT mem_total=3916MB
[2m2026-03-06T11:21:37Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT resource_samples=707
[2m2026-03-06T11:26:42Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] RESULT nm_files=32174
[2m2026-03-06T11:26:42Z[0m app[56836ddef16138] [32mlhr[0m [[34minfo[0m][bench:archil:medium] Completed at 2026-03-06T11:26:42Z
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

### fly-archil-disk-small-workload-control

```
[2m2026-03-06T10:10:00Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Started at 2026-03-06T10:10:00Z
[2m2026-03-06T10:10:02Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m]
⠋ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠙ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠹ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠸ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠼ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠴ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠦ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil[bench:archil:small] Mounted dsk-0000000000005e77 at /mnt/archil
[2m2026-03-06T10:10:05Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT pnpm_install=6.425s
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_peak=35.5%
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_avg=31.8%
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_peak=708MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_avg=663MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_total=3916MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT resource_samples=3
[2m2026-03-06T10:10:16Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT nm_files=2232
[2m2026-03-06T10:10:16Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Completed at 2026-03-06T10:10:16Z
```

### fly-archil-disk-small-workload-eatmydata

```
[2m2026-03-06T10:11:08Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Started at 2026-03-06T10:11:08Z
[2m2026-03-06T10:11:11Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m]
⠋ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠙ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠹ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠸ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠼ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠴ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠦ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil[bench:archil:small] Mounted dsk-0000000000005e77 at /mnt/archil
[2m2026-03-06T10:11:14Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Running: eatmydata pnpm install lodash chalk request commander express (node_modules + store on Archil)
[2m2026-03-06T10:11:14Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Using eatmydata (fsync no-op)
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT pnpm_install=5.529s
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_peak=43.9%
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_avg=39.8%
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_peak=675MB
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_avg=647MB
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_total=3916MB
[2m2026-03-06T10:11:19Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT resource_samples=2
[2m2026-03-06T10:11:24Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT nm_files=2232
[2m2026-03-06T10:11:24Z[0m app[e7844ee5ae42d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Completed at 2026-03-06T10:11:24Z
```

### fly-archil-disk-small-workload-nconnect4

```
[2m2026-03-06T10:13:24Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] Started at 2026-03-06T10:13:24Z
[2m2026-03-06T10:13:27Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] Mounted dsk-0000000000005e77 at /mnt/archil
[2m2026-03-06T10:13:29Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[2m2026-03-06T10:13:29Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] Mount opts: --nconnect 4
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT pnpm_install=6.530s
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_peak=43.4%
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_avg=36.6%
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_peak=715MB
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_avg=683MB
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_total=3916MB
[2m2026-03-06T10:13:36Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT resource_samples=3
[2m2026-03-06T10:13:41Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT nm_files=2232
[2m2026-03-06T10:13:41Z[0m app[6e82edd0f20008] [32mlhr[0m [[34minfo[0m][bench:archil:small] Completed at 2026-03-06T10:13:41Z
```

### fly-archil-disk-small-workload-writeback-cache

```
[2m2026-03-06T10:12:17Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Started at 2026-03-06T10:12:17Z
[2m2026-03-06T10:12:20Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Mounted dsk-0000000000005e77 at /mnt/archil
[2m2026-03-06T10:12:24Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[2m2026-03-06T10:12:24Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Mount opts: --writeback-cache
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT pnpm_install=7.276s
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_peak=43.3%
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_avg=40.3%
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_peak=687MB
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_avg=653MB
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_total=3916MB
[2m2026-03-06T10:12:31Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT resource_samples=3
[2m2026-03-06T10:12:36Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT nm_files=2232
[2m2026-03-06T10:12:36Z[0m app[9185177da214d8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Completed at 2026-03-06T10:12:36Z
```

### fly-archil-disk-small-workload

```
[2m2026-03-06T10:10:00Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Started at 2026-03-06T10:10:00Z
[2m2026-03-06T10:10:02Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m]
⠋ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠙ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠹ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠸ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠼ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠴ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil
⠦ Attaching Archil volume dsk-0000000000005e77 to mountpoint /mnt/archil[bench:archil:small] Mounted dsk-0000000000005e77 at /mnt/archil
[2m2026-03-06T10:10:05Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT pnpm_install=6.425s
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_peak=35.5%
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT cpu_avg=31.8%
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_peak=708MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_avg=663MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT mem_total=3916MB
[2m2026-03-06T10:10:11Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT resource_samples=3
[2m2026-03-06T10:10:16Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] RESULT nm_files=2232
[2m2026-03-06T10:10:16Z[0m app[9185177da21ed8] [32mlhr[0m [[34minfo[0m][bench:archil:small] Completed at 2026-03-06T10:10:16Z
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
