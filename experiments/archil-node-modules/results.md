# Archil node_modules benchmark

Environment: Fly `lhr` (London) — 4 shared vCPUs, 4 GB RAM
Archil disk: `aws-eu-west-1` (Ireland), backed by Cloudflare R2 (Western Europe)
Workload: `pnpm install lodash chalk request commander express` (114 packages, 2232 files)

### baseline

```
[bench:baseline] Started at 2026-03-05T19:22:46Z
[bench:baseline] Running: pnpm install lodash chalk request commander express
[bench:baseline] RESULT pnpm_install=1.595s
[bench:baseline] RESULT nm_files=2232
[bench:baseline] Completed at 2026-03-05T19:22:50Z
```

### archil

```
[bench:archil] Started at 2026-03-05T19:23:34Z
[bench:archil] Mounted dsk-0000000000005d67 at /mnt/archil
[bench:archil] Running: pnpm install lodash chalk request commander express (node_modules + store on Archil)
[bench:archil] RESULT pnpm_install=6.465s
[bench:archil] RESULT nm_files=2232
[bench:archil] Completed at 2026-03-05T19:23:52Z
```

### summary

| Scenario   | pnpm install | Files | Slowdown |
| ---------- | ------------ | ----- | -------- |
| Local disk | 1.6s         | 2232  | 1x       |
| Archil     | 6.5s         | 2232  | 4x       |
