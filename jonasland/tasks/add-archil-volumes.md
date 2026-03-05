---
state: todo
priority: high
size: medium
tags:
  - jonasland
  - storage
  - archil
  - sandbox
dependsOn: []
---

# Add Archil volumes

## Goal

Add a minimum technical POC for Archil-backed persistent storage in jonasland sandboxes, runtime-agnostic across Docker and Fly, using the FUSE filesystem mount path.

## Requested constraints

- Main runtimes: Docker and Fly.
- Persistence scope: per-project.
- Writer model: single writer, many readers.
- Prefer true filesystem mount (not SDK-only path).
- Evaluate whether mounting user home is viable vs dumb.

## Research summary (important constraints)

- Archil is managed by default; no clear public OSS self-host package found.
- Archil docs mention BYOC via contact and a high-size threshold (100+ TiB).
- Archil supports shared mounts with ownership/delegation model (`checkout` / `checkin`).
- Disk consistency is strong for mounted clients; sync to backing object store is eventual.
- Container mounting requires FUSE privileges (`SYS_ADMIN` + `/dev/fuse`, or broader privileged mode).
- Fly appears FUSE-capable in practice (LiteFS-on-Fly docs), but this is inference from Fly + LiteFS guidance, not an Archil-specific Fly statement.
- Current documented Archil limits in progress: files >20 GiB, directories >20,000 entries, ACL gaps.
- Node/JS workloads likely fine on file size, but huge cache/dep trees can stress entry-count limits.

## Design guardrails for POC

- Do not mount Archil directly over `/home/iterate` in v0.
- Mount under stable prefix, for example:
  - `/mnt/archil/projects/<project-id>/workspace`
  - `/mnt/archil/projects/<project-id>/state`
  - `/mnt/archil/projects/<project-id>/logs`
  - `/mnt/archil/projects/<project-id>/artifacts`
- Bind/symlink selected home paths into mounted dirs instead of replacing full home.
- Keep ephemeral paths local:
  - `/tmp`
  - transient build outputs
  - pnpm store / `node_modules` initially (revisit after baseline works)

## Env var model

- Platform injects mount credentials and config:
  - Docker provider env injection on create.
  - Fly machine config env.
- Startup script mounts Archil before pidnap starts managed processes.
- Auth vars are mount-time only and separate from app/service env.
- Token auth var to verify against installed Archil client version:
  - historically `ARCHIL_MOUNT_TOKEN`
  - newer client notes mention `ARCHIL_AUTH_TOKEN`

## POC plan

### Phase 1: Docker proof

- Install Archil client in sandbox image.
- Ensure FUSE support and container run options include required capability/device.
- Mount Archil in startup before pidnap process tree.
- Write/read smoke:
  - create file in project `state`
  - restart container
  - verify data persisted

### Phase 2: Fly proof

- Same startup mount ordering in fly machine image.
- Validate mount succeeds on machine boot and is visible to services.
- Write/read smoke across machine restart or replacement scenario.
- Confirm single-writer behavior and read-only from secondary reader process.

### Phase 3: Home path mapping experiment

- Try selective mapping first (`.cache` excluded).
- If stable, optionally test broader home overlay in isolated branch.
- Abort full-home mount if bootstrap/env/bin skeleton gets masked or startup becomes fragile.

## Acceptance criteria

- Docker sandbox can mount Archil and persist per-project data across restarts.
- Fly machine can mount Archil and persist per-project data across restarts.
- Services can read/write project `workspace/state/logs/artifacts` paths.
- Startup ordering is deterministic: mount succeeds before dependent services start.
- No secrets baked into image layers or committed config.
- Documentation added for required runtime flags/env and known caveats.

## Risks / unknowns to close

- Exact Fly machine requirements for `/dev/fuse` exposure in this stack.
- Archil auth env var name by installed CLI version.
- Behavior under forced delegation takeover (`--force`) and possible write loss.
- Directory growth pressure for large JS dependency/cache trees.
- Whether logs should share the same Archil disk/prefix as state or be split.

## References

- https://docs.archil.com/getting-started/quickstart
- https://docs.archil.com/details/architecture
- https://docs.archil.com/details/consistency
- https://docs.archil.com/details/support
- https://docs.archil.com/concepts/shared-disks
- https://docs.archil.com/reference/changelog
- https://fly.io/docs/litefs/getting-started-fly/
- https://docs.docker.com/engine/containers/run/
