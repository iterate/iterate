# Cloudflare Sandbox SDK Local Dev On Apple Silicon

This documents the local development failure mode we hit while wiring
`apps/example` to Cloudflare's Sandbox SDK on an Apple Silicon Mac using
OrbStack Docker.

Last validated: 2026-05-06.

## TL;DR

Cloudflare Sandbox SDK local dev works in this repo on OrbStack, but Apple
Silicon needs an arm64 egress sidecar override:

```bash
MINIFLARE_CONTAINER_EGRESS_IMAGE=cloudflare/proxy-everything@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c \
  pnpm --dir apps/example cf:dev
```

`apps/example/package.json` applies this automatically for `arm64`/`aarch64`
hosts. Do not replace it with a node_modules patch or a pre-dev package patch.

## What Is Going On

Cloudflare Containers local dev starts two Docker containers for a sandbox:

- the actual sandbox container image
- an egress sidecar image, `cloudflare/proxy-everything`, that mirrors
  Cloudflare's outbound traffic interception locally

Cloudflare's Containers docs describe this local development behavior: outbound
interception spawns a sidecar process inside the container network namespace and
uses `TPROXY` rules to route matching traffic to local Workerd.

Relevant docs:

- https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
- https://developers.cloudflare.com/sandbox/get-started/
- https://developers.cloudflare.com/sandbox/api/commands/

The problem is not the Sandbox SDK API usage. The same failure reproduces with
Cloudflare's minimal Sandbox SDK template on affected machines.

## Symptom

Cloudflare local dev starts, then sandbox requests hang or return 500. Docker
shows an exited `proxy-everything` sidecar:

```bash
docker ps -a --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' |
  rg 'proxy-everything|workerd-example'
```

Sidecar logs show:

```text
TLS interception enabled, CA written to /ca/ca.crt
Fatal error:  setsockoptint: protocol not available
```

The sandbox container may then loop through errors like "No such container"
because the sidecar failed before the local container runtime finished wiring
the sandbox network.

## Root Cause

On Apple Silicon, Cloudflare's local-dev tooling pulls/runs the
`cloudflare/proxy-everything` egress sidecar as `linux/amd64`. Under OrbStack's
amd64 emulation path, that sidecar fails while setting socket options for the
TPROXY-based egress interception path.

The same sidecar image has an arm64 manifest. Running that arm64 manifest works
on the same OrbStack install:

```bash
docker manifest inspect cloudflare/proxy-everything:3cb1195 |
  rg -n 'architecture|digest|platform' -C 2
```

At the time this was debugged:

- amd64 digest:
  `sha256:6b7ab58f31166045c25047ab81d707e6d7746efe6047eb9b06f43afd64cfc1c9`
- arm64 digest:
  `sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c`

Direct repro:

```bash
docker run --rm --platform linux/amd64 --cap-add NET_ADMIN \
  cloudflare/proxy-everything:3cb1195 \
  /proxy-everything \
  --host 127.0.0.1 \
  --port 8080 \
  --proxy-to 127.0.0.1 \
  --proxy-to-port 8081 \
  --tls-intercept \
  --disable-ipv6
```

On the affected OrbStack setup, that exits with:

```text
Fatal error:  setsockoptint: protocol not available
```

The arm64 digest starts:

```bash
docker run --rm --cap-add NET_ADMIN \
  cloudflare/proxy-everything@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c \
  /proxy-everything \
  --host 127.0.0.1 \
  --port 8080 \
  --proxy-to 127.0.0.1 \
  --proxy-to-port 8081 \
  --tls-intercept \
  --disable-ipv6
```

Expected output starts with:

```text
Proxy address: 127.0.0.3, Port: 41209
```

## Known Upstream Reports

This is known upstream, not specific to this repo:

- Exact Sandbox SDK / OrbStack / Apple Silicon issue:
  https://github.com/cloudflare/sandbox-sdk/issues/522
- Related Workers SDK sidecar issue:
  https://github.com/cloudflare/workers-sdk/issues/12965
- Related tag/digest image lookup issue:
  https://github.com/cloudflare/workers-sdk/issues/13672
- PR related to the tag/digest lookup issue:
  https://github.com/cloudflare/workers-sdk/pull/13720

Cloudflare may eventually fix the platform selection. When they do, remove the
arm64 `MINIFLARE_CONTAINER_EGRESS_IMAGE` override from `apps/example`.

## Repo Workaround

`apps/example/package.json` sets the override only on arm64/aarch64 hosts:

```bash
if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then
  export MINIFLARE_CONTAINER_EGRESS_IMAGE=cloudflare/proxy-everything@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c
fi
doppler run --project example -- tsx ./alchemy.run.ts
```

This is intentionally an environment variable, not a mutation of
`node_modules`. Cloudflare's local-dev code already reads
`MINIFLARE_CONTAINER_EGRESS_IMAGE`.

## OrbStack Cleanup We Performed

The broken sidecar was not caused by OrbStack's Docker TCP API listener, but the
local Docker daemon was exposing an unauthenticated local TCP API. We removed it.

Current expected config:

```bash
cat ~/.orbstack/config/docker.json
```

```json
{
  "hosts": ["unix:///var/run/docker.sock"]
}
```

We also disabled LAN exposure:

```bash
orbctl config get docker.expose_ports_to_lan
orbctl config get machines.expose_ports_to_lan
```

Expected:

```text
false
false
```

Rosetta did not fix the Cloudflare sidecar issue under OrbStack, so it was
restored to its previous setting:

```bash
orbctl config get rosetta
```

Expected on this machine:

```text
true
```

## About `DOCKER_INSECURE_NO_IPTABLES_RAW`

`docker info` may still show:

```text
WARNING: DOCKER_INSECURE_NO_IPTABLES_RAW is set
```

That variable is set inside OrbStack's Docker host for `dockerd`; it is not from
the user's shell environment. On the machine we debugged, the OrbStack kernel
did have raw table support:

```bash
docker run --rm --privileged --pid=host alpine:3.22 sh -lc '
  pid=$(pidof dockerd)
  tr "\0" "\n" < /proc/$pid/environ | sort | grep DOCKER_INSECURE_NO_IPTABLES_RAW || true
  zcat /proc/config.gz 2>/dev/null | grep CONFIG_IP_NF_RAW || true
'
```

Observed:

```text
DOCKER_INSECURE_NO_IPTABLES_RAW=1
CONFIG_IP_NF_RAW=y
```

Docker added this env var as a workaround for kernels without
`CONFIG_IP_NF_RAW`. Moby currently does not expose it as a `daemon.json` option:

- https://github.com/moby/moby/pull/49621
- https://github.com/moby/moby/issues/49651

That warning is worth tracking, but direct testing showed it was not the cause
of the Cloudflare sidecar crash: arm64 `proxy-everything` worked with the
warning still present, while amd64 `proxy-everything` failed.

## How To Verify `apps/example`

Start Cloudflare local dev:

```bash
PORT=5174 pnpm --dir apps/example cf:dev
```

Open:

```text
http://127.0.0.1:5174/sandbox
```

Expected UI:

- left sidebar contains `Sandbox`
- the page status shows sandbox id `example-poc`
- clicking `Run code` eventually shows `exit 0`
- stdout contains Node version, `/workspace`, and `egressStatus: 200`

API smoke:

```bash
curl -sS -m 120 http://127.0.0.1:5174/api/sandbox
```

Expected shape:

```json
{
  "sandboxId": "example-poc",
  "status": "ready",
  "stdout": "{\"node\":\"v20.20.2\",\"platform\":\"linux\",\"arch\":\"x64\",\"cwd\":\"/workspace\"}",
  "stderr": "",
  "exitCode": 0
}
```

Run code with internet egress:

```bash
curl -sS -m 120 \
  -X POST http://127.0.0.1:5174/api/sandbox/run \
  -H 'content-type: application/json' \
  --data '{"code":"const res = await fetch(\"https://example.com\"); console.log(JSON.stringify({ sum: 2 + 3, status: res.status, node: process.version, cwd: process.cwd() }, null, 2));"}'
```

Expected:

```json
{
  "sandboxId": "example-poc",
  "command": "node /workspace/user-code.mjs",
  "success": true,
  "stdout": "{\n  \"sum\": 5,\n  \"status\": 200,\n  \"node\": \"v20.20.2\",\n  \"cwd\": \"/workspace\"\n}",
  "stderr": "",
  "exitCode": 0
}
```

## Troubleshooting

If `cf:dev` starts but sandbox requests hang:

1. Check for a failed sidecar:

   ```bash
   docker ps -a --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' |
     rg 'proxy-everything|workerd-example'
   ```

2. Check sidecar logs:

   ```bash
   docker logs <proxy-container-id> 2>&1 | tail -100
   ```

3. If logs include `setsockoptint: protocol not available`, confirm the arm64
   override is present in the `cf:dev` environment:

   ```bash
   pnpm --dir apps/example cf:dev
   ```

   The startup output should include:

   ```text
   cloudflare/proxy-everything@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c
   ```

4. Remove stale failed containers if needed:

   ```bash
   docker rm -f $(docker ps -aq --filter name=workerd-example-dev) 2>/dev/null || true
   ```

5. Clear a stale sidecar image if Docker appears to reuse the wrong platform:

   ```bash
   docker image rm -f cloudflare/proxy-everything:3cb1195 2>/dev/null || true
   ```

6. Restart:

   ```bash
   PORT=5174 pnpm --dir apps/example cf:dev
   ```

## What Not To Do

- Do not patch Wrangler or `@cloudflare/vite-plugin` in `node_modules`.
- Do not set `enableInternet = false`; this POC intentionally proves public
  internet egress.
- Do not assume `DOCKER_INSECURE_NO_IPTABLES_RAW` is the cause of the sandbox
  crash without reproducing the sidecar directly.
- Do not pin the arm64 sidecar for every platform. Keep the override scoped to
  Apple Silicon hosts unless Cloudflare changes the local-dev behavior.
