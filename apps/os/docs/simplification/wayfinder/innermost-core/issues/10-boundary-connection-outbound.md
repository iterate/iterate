# 10 — The boundary-crossing connection (outbound to the next shell)

Type: research
Status: open
Blocked by: —

Jonas, very concretely: an alarm inside a project (in a customer's CF account) needs to fetch the internet.
How does that work? Does every stateless worker open a capnweb connection to the control plane (slow —
capnweb handshake is slow)? Or does everything go through the project DO (a chokepoint, but it can hold a
standing/future-hibernatable connection)? Two code paths (Workers RPC vs public internet)? "This all seems
pretty crazy... I worry stuff gets slow, but I also worry about over-optimization."

## The distinction that dissolves half of it: LOCAL vs MEDIATED capabilities

- **LOCAL-binding capabilities** — `itx.kv`, `itx.r2`, a stream DO. Backed by a **binding in the local
  account** (dedicated, or shared+`<projectId>:`-prefixed). **No cross-shell connection at call time.** The
  control plane only _provisioned_ the namespace once. → the KV/R2 proof (`08`) needs no standing connection.
- **MEDIATED capabilities** — metered egress (first-party keys + metering), the directory, product caps
  (Slack). These are **served by an outer shell** and must reach it at call time. → these need the boundary
  connection below.

So most of a project (KV, R2, streams, compute) is **local** and fast; only the genuinely-outer capabilities
cross a boundary.

## The boundary connection = ONE interface, TWO providers (no two code paths in user/platform code)

`itx.<mediated>` resolves the parent by NAME (§8 fork 9). The name resolves to a **provider**:

- **Same account (hosted):** a **Workers RPC service binding** (`env.CONTROL_PLANE`). Fast, no handshake.
- **Cross account (self-host / level-2):** a **connection-holder DO** that owns ONE **standing
  (future-hibernatable) capnweb connection** to the control plane and exposes the _same_ RpcTarget interface
  locally. Handshake paid **once**, reused for all calls.

**Reconciles fork 9 with performance:** "re-dial the parent by name per call, never retain a stub" applies to
the **same-account hop** (worker → connection-holder DO by name = `env.NS.getByName(name)`, cheap, no
handshake, no leak). The **retained cross-account capnweb stub lives in exactly ONE place** — the
connection-holder DO, keyed by connection, evicted via `onRpcBroken` — which is precisely the red-team's
prescription. Leak-avoidance on the cheap hop; warm-connection on the expensive hop.

## THE FRACTAL (Jonas's own insight): outbound ≡ inbound, same primitive

- **Inbound** (device → project): a **pager DO** holds hibernatable sockets to devices, pages them; a device
  dials an RPC leg **inward**.
- **Outbound** (project → control-plane): a **connection-holder DO** holds a standing connection **outward**;
  forwards calls out.

Both = "a DO that owns the boundary-crossing connection and presents the same interface locally." **Same
primitive, opposite direction.** So this isn't new complexity — it's the pager (D7) pointed outward.

## Over-optimization guard

v1 self-host can be dumb: mediated egress = per-call capnweb (slow but correct), or even **direct `fetch()`**
when there's no product (metering/first-party keys are a PRODUCT concern — a bare self-hosted control plane
may not mediate egress at all). The connection-holder DO is the _performant_ form, built when the standing
connection is worth it (and hibernatable when capnweb/workerd #6087 ships). Don't build it before it pays.

## What's deployed where (the AppConfig + bindings answer)

The ONLY differences between deployments are **AppConfig flags + bindings**; user code is identical.

|                   | hosted (our account)                                                | BYO / self-host (their account)                                                                 |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `itx.kv` binding  | shared `env.KV`, `kvMode:"shared-prefixed"` → prefix `<projectId>:` | dedicated `env.KV`, `kvMode:"dedicated"` → no prefix                                            |
| `itx.r2` binding  | shared `env.R2` + `<projectId>/` path                               | dedicated bucket                                                                                |
| parent (mediated) | `env.CONTROL_PLANE` service binding                                 | `env.CP_PROXY` connection-holder DO (standing capnweb) + `controlPlaneUrl`/credential in config |
| egress            | via control-plane (metered)                                         | direct `fetch()` (no product) OR via CP_PROXY (level-2)                                         |

The itx providers read AppConfig + which binding is present and present a fixed interface (ADR 0021:
presence & sourcing are config, not a code fork).

## Questions

- Shard the connection-holder DO for high-volume mediated calls? (single-threaded chokepoint.)
- Is the connection-holder DO's interface literally the control-plane context's RpcTarget (so it's a
  transparent proxy), or a typed subset?
- Does authentication happen once at connection-open (born project key / mutual credential) and then all
  calls ride the authenticated session? (yes — amortize auth with the handshake.)
