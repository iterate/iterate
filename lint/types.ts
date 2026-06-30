import type { ESLint, Rule } from "eslint";

/** The keys of NodeListener that have a corresponding `*:exit` key - these are all the node names that can be used in a rule listener. */
type ListenableNodeName =
  Extract<keyof Rule.NodeListener, `${string}:exit`> extends `${infer Name}:exit` ? Name : never;

/** Helper methods on RuleListener - together with `ListenableNodeName`, we can reconstruct `RuleListener` without an overly permissive `[key: string]` index type */
type RuleListenerMethods = Pick<
  Rule.RuleListener,
  | "onCodePathStart"
  | "onCodePathEnd"
  | "onCodePathSegmentStart"
  | "onCodePathSegmentEnd"
  | "onCodePathSegmentLoop"
>;
type SelectorQualifier = "" | `:${string}` | `[${string}]`;
export type StrictRule = Omit<Rule.RuleModule, "create"> & {
  create: (context: Rule.RuleContext) => Rule.NodeListener &
    RuleListenerMethods & {
      // Infer direct node selectors and qualified variants like `Identifier:exit` or `VariableDeclarator[init.callee.object.name='z']`.
      [Name in ListenableNodeName as `${Name}${SelectorQualifier}`]?: Rule.NodeListener[LeafNode<Name>];
    } & {
      // Infer comma selectors from the first selector segment; overlapping mapped entries can produce unions for concrete keys.
      [Name in ListenableNodeName as `${string}${Name}${SelectorQualifier},${string}`]?: Rule.NodeListener[LeafNode<Name>];
    } & {
      // Infer comma selectors from the last selector segment; overlapping mapped entries can produce unions for concrete keys.
      [Name in ListenableNodeName as `${string},${string}${Name}${SelectorQualifier}`]?: Rule.NodeListener[LeafNode<Name>];
    } & {
      // Infer descendant selectors from the rightmost node selector, which is the node passed to the listener.
      [Name in ListenableNodeName as `${string} ${Name}${SelectorQualifier}`]?: Rule.NodeListener[LeafNode<Name>];
    };
};

type LeafNode<S extends string> = S extends `${infer Head},${string}`
  ? LeafNode<Head>
  : S extends `${string} ${infer Tail}`
    ? LeafNode<Tail>
    : S extends `${infer Head extends ListenableNodeName}${":" | "[" | ","}${string}`
      ? Head
      : Extract<S, ListenableNodeName>;

/** Like ESLint.Plugin, but with slightly more helpful/stricter types. Rules that listen on selectors like `VariableDeclarator[init.callee.object.name='z']` will have their node type inferred from the selector. */
export type StrictPlugin = Omit<ESLint.Plugin, "rules"> & {
  rules: Record<string, StrictRule>;
};
