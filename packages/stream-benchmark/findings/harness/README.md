# Append throughput benchmark harness

All reproducible benchmark code for `findings/findings.md` lives here.

| File                          | What it measures                                                                |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `websocket-external-cli.ts`   | Node client → public `wss://` → Stream DO (Internet RTT + echo)                 |
| `websocket-from-worker.ts`    | Worker `stub.fetch` + `Upgrade: websocket` → Stream DO (edge, no public RTT)    |
| `benchmark-driver.ts`         | Separate DO calls Stream via same WebSocket pattern                             |
| `rpc-from-worker.ts`          | Worker `stub.append` / `appendBatch` RPC                                        |
| `websocket-pump.ts`           | Shared send/wait-for-echo loop; optional partysocket reconnect + `after` resume |
| `run-comparison.sh`           | Runs the 10k comparison suite                                                   |
| `chaos.ts`                    | Worker-side kill RPC + chaos loop (`ctx.abort`)                                 |
| `chaos-monkey.ts`             | CLI → `POST /chaos/kill` or `POST /chaos/run`                                   |
| `run-chaos-with-benchmark.sh` | Background chaos + WebSocket load on one path                                   |

Deploy the parent package first (`pnpm deploy` from `packages/stream-benchmark`), then:

```bash
bash findings/harness/run-comparison.sh https://stream-benchmark.iterate-dev-preview.workers.dev 10000
```

Chaos (kill DOs randomly while benchmarking):

```bash
# single kill
pnpm benchmark:chaos https://stream-benchmark.<host>.workers.dev \
  --kill-once --binding stream --path /bench-alpha

# loop (runs on Worker for durationMs)
pnpm benchmark:chaos https://stream-benchmark.<host>.workers.dev \
  --binding stream --path-prefix /bench-chaos --paths 10 --duration-ms 60000

# chaos + load on sibling paths
bash findings/harness/run-chaos-with-benchmark.sh https://stream-benchmark.<host>.workers.dev 5000

# resilient client (resumes at last echoed offset after DO abort)
pnpm exec tsx findings/harness/websocket-external-cli.ts \
  "https://stream-benchmark.<host>.workers.dev/my-stream" --reconnect --messages 5000
```
