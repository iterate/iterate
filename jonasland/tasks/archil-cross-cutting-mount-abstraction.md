---
state: todo
priority: high
size: medium
tags:
  - jonasland
  - storage
  - archil
  - abstraction
dependsOn: []
---

# Archil cross-cutting mount abstraction

## Goal

Design a storage abstraction that can express mounted filesystems across Docker, Fly, and Archil-backed sandboxes without conflating that with rootfs restart persistence.

## Context

We now have a simple `rootfsSurvivesRestart` knob for deployment instance options.

That knob is intentionally narrow:

- Docker: approximates local container writable-layer restart behavior
- Fly: maps to Fly rootfs persistence for restart convenience
- It is not durable storage
- It is not a mounted disk abstraction

Archil should be modeled separately because it is naturally a mounted filesystem abstraction, not a rootfs persistence mechanism.

## Why this should be cross-cutting

The same conceptual shape appears in multiple providers:

- Fly Volumes mount at explicit paths
- Docker named volumes / bind mounts mount at explicit paths
- Archil disks mount at explicit paths

So the abstraction should likely be `mounts`, not a single `volume` field.

## Recommended direction

Add a provider-facing `mounts` list under deployment `instanceSpecificOpts`.

Candidate shape:

```ts
type DeploymentMount =
  | {
      kind: "volume";
      mountPath: string;
      purpose?: "state" | "workspace" | "logs" | "artifacts";
      sizeGb?: number;
      retainOnDestroy?: boolean;
    }
  | {
      kind: "archil";
      mountPath: string;
      diskName: string;
      shared?: boolean;
      mode?: "single-writer" | "shared";
      purpose?: "state" | "workspace" | "logs" | "artifacts";
    };
```

Provider resolution:

- Docker:
  - `kind: "volume"` -> named volume or bind mount
  - `kind: "archil"` -> Archil mount inside the runtime
- Fly:
  - `kind: "volume"` -> Fly Volume
  - `kind: "archil"` -> Archil FUSE mount inside the machine

## Important separation

Keep these separate in the API:

- `rootfsSurvivesRestart`
- `mounts`

Reason:

- rootfs restart persistence is a convenience behavior
- mounts are explicit attached filesystems
- Archil belongs in mounts
- Fly Volumes belong in mounts

## Archil constraints to preserve

- single writer, many readers is the intended default
- startup ordering matters; mount before dependent services
- FUSE requirements matter in Docker and Fly
- do not mount directly over the whole home directory in v0

## Suggested mount layout

Prefer multiple logical mount targets over one huge opaque mount:

- `/mnt/archil/projects/<project-id>/workspace`
- `/mnt/archil/projects/<project-id>/state`
- `/mnt/archil/projects/<project-id>/logs`
- `/mnt/archil/projects/<project-id>/artifacts`

Then bind or symlink selected runtime paths into those mounted locations.

## Questions to resolve

- Should `kind: "volume"` stay generic, with provider-specific resolution under the hood?
- Should Archil have its own mount kind or be one implementation of a more generic network/shared-disk kind?
- Should mounts be able to declare read-only vs read-write?
- How should retention be expressed across Docker named volumes, Fly Volumes, and Archil disks?
- Do we want explicit mount purposes (`state`, `workspace`, `logs`, `artifacts`) or just raw mount paths?

## Acceptance criteria

- A deployment can express more than one mount
- The abstraction works for Fly Volumes and Archil
- Docker has a local equivalent
- Rootfs restart persistence remains separate and optional
- Runtime config recovery persists and recovers mount metadata from the provider runtime

## References

- `jonasland/tasks/add-archil-volumes.md`
- https://docs.archil.com/getting-started/quickstart
- https://docs.archil.com/details/architecture
- https://docs.archil.com/details/consistency
- https://docs.archil.com/concepts/shared-disks
- https://fly.io/docs/apps/volume-storage/
- https://fly.io/docs/volumes/overview/
