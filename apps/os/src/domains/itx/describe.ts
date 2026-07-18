/**
 * The `__describe()` discovery convention. Every node in the capability tree
 * answers `__describe()`; these shapes are what it returns. They are part of
 * the public itx contract — the `describeNode` helper in ./utils.ts fills the
 * always-present fields.
 */

/**
 * Self-description of one node in the capability tree — what `__describe()`
 * returns, on EVERY node, by convention.
 *
 * This is the discovery groundwork: `instructions` and `types` are always
 * present and describe THIS node; `children` is the high-level map (one-line
 * blip per child member) so a caller can see what exists without walking;
 * `parent` says where the node sits. Deep discovery is a walk: call
 * `__describe()` on the children you care about. Nodes add structured extras
 * (a project adds `projectId`, an agent adds `whoami`, a capability host adds
 * `capabilities`), so `__describe` is also the identity query — there is no
 * separate `describe()`/`whoami()`.
 *
 * Today each node hand-writes its description (the `describeNode` helper only
 * enforces the shape); the plan is to grow this into a transitive mechanism
 * where a parent composes its children's descriptions.
 */
export type Description = {
  /** Prose: what this node is and how to use it. */
  instructions: string;
  /** TypeScript source for this node's surface ("" when not yet written). */
  types: string;
  /** Discovery map: one-line blip per child member. */
  children: Record<string, string>;
  /** Where this node sits / how you reached it. */
  parent?: string;
};

/** What a project itx's `__describe()` returns: the Description convention plus identity and the capability inventory. */
export type ProjectDescription = Description & {
  capabilities: CapabilityDescription[];
  name: string;
  projectId: string;
};

/**
 * One capability in a project's inventory (`__describe().capabilities`): the
 * itx path it is mounted at, how it is implemented (built-in, live-provided,
 * or a persisted itx expression), and optional instructions/types for
 * discovery.
 */
export type CapabilityDescription = {
  instructions?: string;
  path: string[];
  providedAtOffset?: number;
  /**
   * The itx scope path this capability is declared at (`"/"`, `"/agents/bla"`, …).
   * Set when a scope reports capabilities its fallback host contributed, so
   * the reader can tell a local mount from an inherited one. Absent on
   * built-ins (they exist at every scope).
   */
  scope?: string;
  type: "builtin" | "live" | "itx-expression";
  types?: string;
};
