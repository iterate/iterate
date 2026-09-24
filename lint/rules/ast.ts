import type { Node } from "estree";

/** The static name of a property key or member property: `a.name`, `a["name"]`, `{ name: … }`. */
export function getPropertyName(node: Node | undefined) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}
