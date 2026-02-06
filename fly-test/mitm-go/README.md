# mitm-go

Go-based MITM path (current implementation).

## Files

- `go-mitm/main.go`: Go `goproxy` daemon.
- `go-mitm/go.mod`: module + deps.
- `start.sh`: minimal runtime command used by egress startup.

## Minimal runtime config

Required env:

- `MITM_PORT` (default `18080`)
- `TRANSFORM_URL` (default `http://127.0.0.1:18081/transform`)
- `MITM_CA_CERT` (default `/data/mitm/ca.crt`)
- `MITM_CA_KEY` (default `/data/mitm/ca.key`)
- `MITM_LOG` (default `/tmp/egress-proxy.log`)

Run:

```bash
bash fly-test/mitm-go/start.sh
```
