import type { MountMode, MountSpec } from "./types.ts";

export type IndexedMount = MountSpec & {
  mode: MountMode;
};

export type MountIndex = {
  builtins: Map<string, IndexedMount>;
  functions: Map<string, IndexedMount>;
  objects: Map<string, IndexedMount>;
  pathDispatch: IndexedMount[];
};

function mountKey(path: string[]) {
  return path.join("\0");
}

export function buildMountIndex(mounts: MountSpec[] = []): MountIndex {
  const index: MountIndex = {
    builtins: new Map(),
    functions: new Map(),
    objects: new Map(),
    pathDispatch: [],
  };

  for (const mount of mounts) {
    const normalized: IndexedMount = {
      ...mount,
      mode: mount.mode ?? (mount.path.length === 0 ? "function" : "object"),
    };

    if ("capability" in mount.target) {
      index.builtins.set(mountKey(mount.path), normalized);
      continue;
    }

    switch (normalized.mode) {
      case "function":
        if (mount.path.length !== 1) {
          throw new Error(`function mount ${mount.name} must have exactly one path segment`);
        }
        index.functions.set(mount.path[0]!, normalized);
        break;
      case "object":
        if (mount.path.length !== 1) {
          throw new Error(`object mount ${mount.name} must have exactly one path segment`);
        }
        index.objects.set(mount.path[0]!, normalized);
        break;
      case "path-dispatch":
        index.pathDispatch.push(normalized);
        break;
      default:
        throw new Error(`unknown mount mode for ${mount.name}`);
    }
  }

  index.pathDispatch.sort((left, right) => right.path.length - left.path.length);
  return index;
}

export function findPathDispatchMount(index: MountIndex, path: string[]) {
  for (const mount of index.pathDispatch) {
    if (path.length < mount.path.length) continue;
    const matches = mount.path.every((segment, i) => path[i] === segment);
    if (!matches) continue;
    return {
      mount,
      remainder: path.slice(mount.path.length),
    };
  }
  return null;
}
