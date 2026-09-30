/** A callback ref that focuses its element as it appears — where `autoFocus` would, without the
 *  attribute. Module-level so its identity is stable: React calls it once, on mount. */
export function focusOnMount(node: HTMLElement | null) {
  node?.focus();
}
