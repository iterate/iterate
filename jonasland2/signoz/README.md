# SigNoz (jonasland2)

Uses the official SigNoz Docker deployment.

## Start

```bash
cd jonasland2
./signoz/up.sh
```

## Stop

```bash
cd jonasland2
./signoz/down.sh
```

## Status

```bash
cd jonasland2
./signoz/status.sh
```

## Endpoints

- UI: `http://127.0.0.1:8080`
- OTLP gRPC: `127.0.0.1:4317`
- OTLP HTTP: `127.0.0.1:4318`

Set sandbox OTEL env:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:4318/v1/traces
```
