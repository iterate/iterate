/**
 * An itx SURFACE — the host-minted allowlist of built-in members an itx
 * exposes. Absent means today's full surface. Present means the itx shows
 * ONLY these members (plus `__describe`), and `ItxEntrypoint` mints it with
 * project-confined, non-admin authority.
 *
 * Entries are dotted member paths. A bare root (`"chat"`) allows that whole
 * subtree; a dotted entry (`"agent.message"`) allows one member of a child,
 * and the child itself is narrowed to its listed members — for the members
 * that implement narrowing (NARROWABLE_MEMBERS); a dotted entry under any
 * other member is rejected at parse time. Unknown roots keep
 * resolving through the scope's dynamic capability table, so a removed
 * built-in reads exactly like an unmounted capability: `no capability "repo"`.
 *
 * Enforcement is a PROTOTYPE, not a Proxy: workerd RPC brand-checks method
 * results for pipelining and a Proxy never passes (see
 * installPrototypeInvokeCapabilityFallback in ./utils.ts). A restricted
 * instance keeps its native RpcTarget brand and simply gets a prototype in
 * front of its class prototype that shadows the removed members, deferring
 * them to the dynamic-capability hop beneath the class — so a removed
 * built-in answers exactly like an unknown name.
 */
export type ItxSurface = readonly string[];

const SURFACE_ENTRY = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * The members whose children a dotted entry can narrow: an itx's `agent` and
 * `chat`, an agent's `chat`, `stream`, and `liveState`. Everywhere else a
 * dotted entry is REJECTED rather than silently widened to the whole child
 * (`"repo.readFile"` would otherwise hand out all of `repo`): list the bare
 * root, or nothing.
 */
const NARROWABLE_MEMBERS: ReadonlySet<string> = new Set(["agent", "chat", "liveState", "stream"]);

/** Members every restricted prototype keeps: identity and introspection. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["constructor", "__describe"]);

/** Validate a caller-supplied surface: non-empty dotted identifiers, deduped, sorted. */
export function parseItxSurface(value: unknown): ItxSurface {
  if (!Array.isArray(value)) throw new Error("an itx surface must be an array of member paths");
  const entries = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !SURFACE_ENTRY.test(entry)) {
      throw new Error(
        `invalid itx surface entry ${JSON.stringify(entry)}: expected a dotted member path such as "chat" or "agent.message"`,
      );
    }
    const segments = entry.split(".");
    const unnarrowable = segments.slice(0, -1).find((segment) => !NARROWABLE_MEMBERS.has(segment));
    if (unnarrowable !== undefined) {
      throw new Error(
        `invalid itx surface entry ${JSON.stringify(entry)}: "${unnarrowable}" cannot be narrowed to one member — only ${[...NARROWABLE_MEMBERS].map((name) => `"${name}"`).join(", ")} can; list "${segments[0]}" bare to allow all of it, or leave it out`,
      );
    }
    entries.add(entry);
  }
  return [...entries].sort();
}

/** The root member names a surface allows. */
export function surfaceRoots(surface: ItxSurface): ReadonlySet<string> {
  return new Set(surface.map((entry) => entry.split(".", 1)[0]!));
}

/**
 * The surface a child member sees: the entries under `root` with the root
 * stripped. `undefined` when `root` is listed bare (the whole subtree is
 * allowed, the child is unrestricted). An empty list when nothing under
 * `root` is listed.
 */
export function surfaceUnder(surface: ItxSurface, root: string): ItxSurface | undefined {
  if (surface.includes(root)) return undefined;
  const prefix = `${root}.`;
  return surface
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

const restrictedPrototypes = new WeakMap<object, Map<string, object>>();

/**
 * A prototype that sits between an instance and its class prototype and
 * SHADOWS every own member of the class not on the surface (constructor and
 * `__describe` always stay). Memoised per (prototype, allowed set).
 *
 * A shadow is an accessor that asks the class prototype's own parent for the
 * name — on a class carrying the dynamic-capability hop (see
 * installPrototypeInvokeCapabilityFallback in ./utils.ts) that conjures the
 * same path dispatcher an unknown name gets, so a removed built-in fails
 * exactly like an unmounted capability: `no capability "repo"`. On a class
 * without a hop the parent answers `undefined` and the shadow throws a plain
 * "not available in this scope" instead. The class prototype itself stays in
 * the chain: `instanceof` holds (the hop's trap insists on it), and the
 * class's own logic keeps every member it reaches through private
 * accessors.
 */
export function restrictPrototype(prototype: object, surface: ItxSurface): object {
  const allowed = surfaceRoots(surface);
  const key = [...allowed].sort().join(",");
  let byKey = restrictedPrototypes.get(prototype);
  if (byKey === undefined) {
    byKey = new Map();
    restrictedPrototypes.set(prototype, byKey);
  }
  let restricted = byKey.get(key);
  if (restricted === undefined) {
    restricted = Object.create(prototype) as object;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (allowed.has(name) || ALWAYS_ALLOWED.has(name)) continue;
      Object.defineProperty(restricted, name, {
        configurable: true,
        enumerable: false,
        get() {
          // Read lazily: the hop is installed on the class after module load.
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
