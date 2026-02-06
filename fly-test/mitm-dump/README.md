# mitm-dump

mitmdump-based MITM path (no addon Python files).

Goal: terminate TLS, keep same signing cert as Go path, forward decrypted traffic to Node.

## Files

- `start.sh`: minimal bootstrap + mitmdump command.

## Minimal runtime config

Required env:

- `MITM_PORT` (default `18080`)
- `VIEWER_PORT` (default `18081`)
- `FORWARD_PORT` (default `18082`)
- `MITM_DIR` (default `/data/mitm`)
- `MITM_CONF_DIR` (default `${MITM_DIR}/mitmproxy`)

Expected cert input:

- `${MITM_DIR}/ca.crt`
- `${MITM_DIR}/ca.key`

Run:

```bash
bash fly-test/mitm-dump/start.sh
```

Notes:

- Uses `reverse` mode to route decrypted requests to Node (`http://127.0.0.1:${FORWARD_PORT}`).
- `keep_host_header=true` keeps original destination host so Node can reconstruct target URL.
- This is intentionally minimal to show config surface vs Go.
