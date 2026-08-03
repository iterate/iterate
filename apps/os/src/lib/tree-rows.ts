/**
 * Shared machinery for path-addressed tree lists (agents, streams): flatten a
 * forest into visible rows honoring search and expansion, and toggle a member
 * of an immutable set.
 */

/** A forest flattened to visible list rows. `expanded` is the disclosure
 * state the row renders with (search force-expands every surviving subtree). */
export type TreeRow<T> = { node: T; depth: number; expanded: boolean };

type TreeShape<T> = {
  children: (node: T) => readonly T[];
  key: (node: T) => string;
  matches: (node: T, query: string) => boolean;
};

/**
 * Flatten a forest into the rows a tree list renders, in order, with depth.
 * With a query, a node survives when it or any descendant matches (ancestors
 * stay as context); without one, children render only under explicitly
 * expanded nodes.
 */
export function flattenTreeRows<T>(
  roots: readonly T[],
  shape: TreeShape<T>,
  expandedKeys: ReadonlySet<string>,
  filter = "",
): TreeRow<T>[] {
  const query = filter.trim().toLowerCase();
  const searching = query !== "";
  const walk = (node: T, depth: number): TreeRow<T>[] => {
    const childRows = shape.children(node).flatMap((child) => walk(child, depth + 1));
    if (searching && childRows.length === 0 && !shape.matches(node, query)) return [];
    const expanded = searching || expandedKeys.has(shape.key(node));
    const row: TreeRow<T> = { node, depth, expanded };
    return expanded ? [row, ...childRows] : [row];
  };
  return roots.flatMap((root) => walk(root, 0));
}

export function toggledSet(current: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(member)) next.delete(member);
  else next.add(member);
  return next;
}
