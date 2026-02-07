# mitm-go

Go-based MITM path (proxify embed).

## Files

- `go-mitm/main.go`: tiny Go daemon embedding `proxify`.
- `go-mitm/go.mod`: module + deps.
- `start.sh`: minimal runtime command used by egress startup.

## Minimal runtime config

Required env:

- `MITM_PORT` (default `18080`)
- `HANDLER_URL` (default `http://127.0.0.1:18081/proxy`)
- `PROXIFY_CONFIG_DIR` (default `/data/proxify`)

Run:

```bash
bash fly-test/mitm-go/start.sh
```
