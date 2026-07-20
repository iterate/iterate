/**
 * Keep project creation in parallel e2e tests off the deployment-global ID
 * mint RPC. Admin test callers already own an unguessable UUID, so supplying
 * it with create removes an unnecessary serialized service-binding hop while
 * preserving the production API's project contract.
 */
export function freshTestProjectId(): `prj_${string}` {
  return `prj_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Decorate a Cap'n Web session without changing its public type. The wrapper
 * follows authenticated and duplicated session stubs, and only changes
 * `projects.create`: missing IDs become collision-resistant caller-owned IDs;
 * explicit IDs pass through exactly as supplied.
 */
export function withTestProjectIdentifiers<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);

      if (key === "authenticate" && typeof value === "function") {
        return (...args: unknown[]) => wrapReturnedStub(Reflect.apply(value, target, args));
      }

      if (key === "projects" && isObjectLike(value)) {
        return withProjectCreateIdentifiers(value);
      }

      if (key === "dup" && typeof value === "function") {
        return (...args: unknown[]) => wrapReturnedStub(Reflect.apply(value, target, args));
      }

      return value;
    },
  });
}

function withProjectCreateIdentifiers<T extends object>(projects: T): T {
  return new Proxy(projects, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "create" || typeof value !== "function") return value;

      return (input: unknown, ...rest: unknown[]) =>
        Reflect.apply(value, target, [withProjectId(input), ...rest]);
    },
  });
}

function withProjectId(input: unknown): unknown {
  if (!isRecord(input)) return input;
  return {
    ...input,
    projectId: input.projectId ?? freshTestProjectId(),
  };
}

function wrapReturnedStub(value: unknown): unknown {
  return isObjectLike(value) ? withTestProjectIdentifiers(value) : value;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
