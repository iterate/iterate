/**
 * An itx SURFACE — the host-minted allowlist of built-in members an itx
 * exposes. Absent means today's full surface. Present means the itx shows
 * ONLY these members (plus `__describe`), and `ItxEntrypoint` mints it with
 * project-confined, non-admin authority.
 *
 * Entries are root member names (`"chat"`, `"agent"`). Unknown roots keep
 * resolving through the scope's dynamic capability table, so a removed
 * built-in reads exactly like an unmounted capability: `no capability "repo"`.
 *
 * Enforcement is a PROTOTYPE, not a Proxy: workerd RPC brand-checks method
 * results for pipelining and a Proxy never passes (see
 * installPrototypeInvokeCapabilityFallback in ./utils.ts). A restricted
 * instance keeps its native RpcTarget brand and gets a prototype in front of
 * its class prototype that shadows the removed members, deferring them to
 * the dynamic-capability hop beneath the class.
 */
export type ItxSurface = readonly string[];

/** A surface entry: one built-in member name. */
export const ITX_SURFACE_MEMBER = /^[A-Za-z_$][\w$]*$/;

/** Members every restricted prototype keeps: identity and introspection. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["constructor", "__describe"]);

/** Validate a caller-supplied surface: member names, deduped, sorted. */
export function parseItxSurface(value: unknown): ItxSurface {
  if (!Array.isArray(value)) throw new Error("an itx surface must be an array of member names");
  const entries = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !ITX_SURFACE_MEMBER.test(entry)) {
      throw new Error(
        `invalid itx surface entry ${JSON.stringify(entry)}: expected a member name such as "chat"`,
      );
    }
    entries.add(entry);
  }
  return [...entries].sort();
}

const restrictedPrototypes = new WeakMap<object, Map<string, object>>();

/**
 * A prototype that sits between an instance and its class prototype and
 * SHADOWS every own member of the class not on the surface (constructor and
 * `__describe` always stay). Memoised per (prototype, surface).
 *
 * A shadow is an accessor that asks the class prototype's own parent for the
 * name — on a class carrying the dynamic-capability hop that conjures the
 * same path dispatcher an unknown name gets, so a removed built-in fails
 * exactly like an unmounted capability. On a class without a hop the parent
 * answers `undefined` and the shadow throws a plain "not available" instead.
 * The class prototype stays in the chain: `instanceof` holds (the hop's trap
 * insists on it), and the class's own logic keeps every member it reaches
 * through private accessors.
 */
export function restrictPrototype(prototype: object, surface: ItxSurface): object {
  const key = [...surface].sort().join(",");
  let byKey = restrictedPrototypes.get(prototype);
  if (byKey === undefined) {
    byKey = new Map();
    restrictedPrototypes.set(prototype, byKey);
  }
  let restricted = byKey.get(key);
  if (restricted === undefined) {
    // `Object.create` is typed `any`; what it returns IS an object (the new
    // prototype), so the assertion only names what the lib type loses.
    restricted = Object.create(prototype) as object;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (surface.includes(name) || ALWAYS_ALLOWED.has(name)) continue;
      Object.defineProperty(restricted, name, {
        configurable: true,
        enumerable: false,
        get() {
          // Read lazily: the hop is installed on the class after module load.
          // `Object.getPrototypeOf` is typed `any`; a class prototype's parent
          // is always an object here (never null: every class extends RpcTarget).
          const beyond = Reflect.get(Object.getPrototypeOf(prototype) as object, name, this);
          if (beyond !== undefined) return beyond;
          throw new Error(`"${name}" is not available in this scope (restricted itx surface)`);
        },
      });
    }
    byKey.set(key, restricted);
  }
  return restricted;
}

/** Restrict a freshly constructed instance to `surface`; a no-op when absent. */
export function applySurface(
  target: object,
  surface: ItxSurface | undefined,
  prototype: object,
): void {
  if (surface === undefined) return;
  Object.setPrototypeOf(target, restrictPrototype(prototype, surface));
}
