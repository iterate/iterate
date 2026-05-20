# Stream append throughput — findings log

Append-only record of benchmark results. Reproduce any entry with code in [`harness/`](./harness/).

**Deploy target (dev preview):** `https://stream-benchmark.iterate-dev-preview.workers.dev`  
**Account:** `376ef7ed81b0573f93524de763666c15` (iterate dev/preview)

```bash
cd packages/stream-benchmark
doppler run --project os --config dev_jonas -- pnpm deploy
bash findings/harness/run-comparison.sh https://stream-benchmark.iterate-dev-preview.workers.dev 10000
```

---

## 2026-05-20 — Instrumentation baseline

**Setup:** Workers Analytics Engine dataset `stream_metrics`; one `writeDataPoint` per committed append in `src/stream/v0/stream.ts` (`recordAppendMetric`).

**Harness:** not yet split; see git history for `scripts/benchmark-websocket.ts` and `scripts/benchmark-max-throughput.ts`.

### Single DO, WebSocket from Node (25k appends, 1 connection)

- **Path:** `/bench-limit-single`
- **Result:** ~1,959 appends/s (client counts echo received on same socket)
- **AE peak:** ~2,360 appends in a 1s bucket for that path

### Many DOs (40 × 3k appends, parallel WebSockets)

- **Paths:** `/bench-limit-01` … `/bench-limit-40`
- **Result:** ~27,472 appends/s wall-clock aggregate; ~16,829 appends in one 1s bucket summed across paths

### Observability (Cloudflare MCP / otel)

Sample `hibernatableWebSocket` span during load:

| Field          | Value |
| -------------- | ----- |
| `cpu_time_ms`  | 0     |
| `wall_time_ms` | 4     |
| `durationMS`   | ~503  |

**Interpretation:** not CPU-bound; per-message DO work + SQLite + broadcast + client pipeline dominates.

---

## 2026-05-20 — Worker RPC vs external WebSocket (10k)

**Harness:** early `src/benchmark-rpc.ts` + `scripts/benchmark-websocket.ts` (later moved to `findings/harness/`).

| Mode                 | Path                | Appends/s  | Notes                             |
| -------------------- | ------------------- | ---------- | --------------------------------- |
| External WebSocket   | `/bench-rpc-ws`     | **~2,022** | Waits for each echoed event       |
| Worker RPC serial    | `/bench-rpc-serial` | **~84**    | `await stub.append()` per message |
| Worker RPC batch 100 | `/bench-rpc-batch`  | **~3,730** | No WS echo; 100 appends per RPC   |

**Interpretation:** serial Worker→DO RPC is far slower than pipelined public WebSocket; batch RPC can exceed WS when not waiting for fan-out.

---

## 2026-05-20 — Worker/DO WebSocket via binding (10k)

**Question:** Does calling the Stream DO over WebSocket from inside Cloudflare (Worker or driver DO using `stub.fetch` + `Upgrade: websocket`) beat an external Node client?

**Harness:** [`harness/run-comparison.sh`](./harness/run-comparison.sh) — entries below filled after run.

| Mode                             | Endpoint                                                   | Path                         | Appends/s            | Notes                                                                |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------- | -------------------- | -------------------------------------------------------------------- |
| External Node WS                 | `pnpm exec tsx findings/harness/websocket-external-cli.ts` | `/bench-findings-external`   | **~1,222**           | 10k msgs, echo wait; `elapsedMs` 8181                                |
| Worker WS (`stub.fetch` Upgrade) | `GET /benchmark/ws`                                        | `/bench-findings-worker-ws`  | **~1,988**           | Same pump, no public Internet; `elapsedMs` 5029                      |
| Driver DO WS                     | `GET /benchmark/driver-ws`                                 | `/bench-findings-driver-ws`  | **~1,086** (partial) | 10k requested, **5642 received** — likely Worker→DO RPC wall timeout |
| Worker RPC serial                | `GET /benchmark/rpc?batch=1`                               | `/bench-findings-rpc-serial` | **~48** (2k)         | 10k would take ~2+ min; serial `await stub.append()`                 |
| Worker RPC batch 100             | `GET /benchmark/rpc?batch=100`                             | `/bench-findings-rpc-batch`  | **~3,288**           | No WS echo                                                           |

**How Worker WS works:** `streamStub.fetch("http://benchmark{path}?after=end", { headers: { Upgrade: "websocket" } })` → `response.webSocket.accept()` → `findings/harness/websocket-pump.ts` with `startImmediately: true`. See [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

**How Driver DO WS works:** `BenchmarkDriver` DO (`findings/harness/benchmark-driver.ts`) calls the same helper against `env.STREAM`. Invoked via `GET /benchmark/driver-ws` → `env.BENCHMARK_DRIVER.getByName("default").runWebSocketBenchmark(...)`.

### Takeaways

1. **Not CPU-bound** (otel: `cpu_time_ms` ≈ 0, `durationMS` hundreds of ms per `hibernatableWebSocket` message).
2. **In-Worker WebSocket beats external WebSocket** for this echo benchmark (~2k vs ~1.2k appends/s at 10k) — removes client↔edge RTT; still pays echo + DO serial message handling.
3. **Serial Worker RPC is the worst** (~48/s); **batch RPC** or **WebSocket pipelining** are required for throughput.
4. **Driver DO WebSocket** path works but long runs may be cut off by the outer Worker’s wait on DO RPC (5642/10000 at 10k).

### Harness fix log

- `websocket-pump.ts`: Worker clients use `startImmediately: true` (no `open` event after `accept()`).
- Resolve benchmark `Promise` on last echoed event, not only on `close` (Node undici was hanging at 10k).

---

## 2026-05-20 — Chaos monkey (`ctx.abort`)

**Goal:** Forcibly reset Durable Objects during load to measure throughput impact and recovery.

**Mechanism:** [`src/durable-object-kill.ts`](../src/durable-object-kill.ts) wraps [`ctx.abort`](https://developers.cloudflare.com/durable-objects/api/state/#abort). RPC `kill({ reason? })` on `Stream`, `StreamV1`, and `StreamProcessor`.

**HTTP API (Worker):**

| Endpoint                                                 | Purpose                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /chaos/kill?binding=stream&path=/foo&reason=chaos` | Kill one DO                                                                                           |
| `POST /chaos/run`                                        | JSON body: `binding`, `pathPrefix`, `pathCount`, `durationMs`, `intervalMs`, `killsPerTick`, `reason` |

**Harness:**

```bash
pnpm benchmark:chaos https://stream-benchmark.iterate-dev-preview.workers.dev \
  --kill-once --binding stream --path /bench-chaos-target

bash findings/harness/run-chaos-with-benchmark.sh \
  https://stream-benchmark.iterate-dev-preview.workers.dev 5000
```

**Throughput impact (deployed 2026-05-20):**

| Scenario                                                 | Appends/s  | Completed | Notes                                                                                    |
| -------------------------------------------------------- | ---------- | --------- | ---------------------------------------------------------------------------------------- |
| Baseline WS, 3k, `/bench-chaos-baseline`                 | **~1,677** | 3000/3000 | No chaos                                                                                 |
| 5k + chaos pool 8 paths, 1.5s kills                      | **~1,625** | 5000/5000 | Kills on `/bench-chaos-01` mostly landed _after_ the ~3s run                             |
| 5k + kill _only_ loaded path every ~400ms (no reconnect) | **0**      | 0/5000    | Hung ~126s; pump waited for echoes after `ctx.abort`                                     |
| 5k + same chaos + `--reconnect` (partysocket)            | **~129**   | 5000/5000 | 4 kills / 4s; `reconnects: 1`, `sent: 83008` (resend while disconnected); completes ~39s |

**Takeaway:** `kill()` works (`detail` echoes abort reason). Without reconnect, throughput goes to zero when the active DO aborts. With **partysocket** + cursor resume (`findings/harness/websocket-pump.ts`), the client reconnects and continues the append pump; use `--reconnect` on `websocket-external-cli.ts` or `run-chaos-with-benchmark.sh`.
