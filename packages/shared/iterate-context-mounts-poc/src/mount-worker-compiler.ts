/**
 * Wrap mount worker source so `env` is in scope.
 *
 * User source may be either:
 * - `export default { ... }` object literal
 * - `export default (env) => ({ ... })` factory
 * - `export default { async run({ path, input, args }) { ... } }` path-dispatch worker
 */
export function compileMountWorkerModule(userSource: string): string {
  const trimmed = userSource.trim();
  const factoryBody = trimmed.replace(/^export\s+default\s+/, "").trim();

  return `
import { WorkerEntrypoint } from "cloudflare:workers";

function __createExports(env) {
  const __user = ${factoryBody};
  if (typeof __user === "function") {
    return __user(env);
  }
  return __user;
}

function __resolveTarget(exports, exportName) {
  if (exportName === "default") return exports;
  if (exportName in exports) return exports[exportName];
  throw new Error("Mount worker export not found: " + exportName);
}

function __resolveNested(target, path) {
  let current = target;
  for (const segment of path) {
    if (current == null) {
      throw new Error("Mount path not found: " + path.join("."));
    }
    current = typeof current === "function" ? current[segment] : current[segment];
    if (typeof current === "function" && path[path.length - 1] !== segment) {
      // Allow nested plain objects with methods.
    }
  }
  return current;
}

export default class MountWorker extends WorkerEntrypoint {
  async invoke(input) {
    const env = this.env;
    const exports = __createExports(env);
    const { exportName, path, args } = input;
    const target = __resolveTarget(exports, exportName);

    if (path.length === 0) {
      if (typeof target === "function") {
        return await target(...args);
      }
      if (target != null && typeof target === "object") {
        return target;
      }
      throw new Error("Mount export is not callable or object: " + exportName);
    }

    const parentPath = path.slice(0, -1);
    const methodName = path[path.length - 1];
    const parent = parentPath.length === 0 ? target : __resolveNested(target, parentPath);
    const method = parent?.[methodName];
    if (typeof method !== "function") {
      throw new Error("Mount callable not found: " + [...(parentPath.length ? parentPath : [exportName]), methodName].join("."));
    }
    return await method.apply(parent, args);
  }

  async dispatch(input) {
    const env = this.env;
    const exports = __createExports(env);
    const target = __resolveTarget(exports, input.exportName);
    if (typeof target !== "function") {
      throw new Error("path-dispatch export must be a function: " + input.exportName);
    }
    return await target({
      path: input.path,
      args: input.args,
      input: input.args[0],
    });
  }
}
`;
}
