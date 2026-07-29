// Highlight painting via the CSS Custom Highlight API: ranges live in a
// registry BESIDE the DOM, so painting never mutates nodes React owns and
// re-painting after a render is just re-registering fresh ranges. Styling is
// the host's `::highlight(<name>)` rules; names are `<prefix>-<key>`.

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
  keys(): IterableIterator<string>;
}

interface HighlightApi {
  registry: HighlightRegistry;
  Highlight: new (...ranges: Range[]) => unknown;
}

function highlightApi(): HighlightApi | null {
  const cssGlobal = globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined;
  const highlightCtor = (globalThis as { Highlight?: HighlightApi["Highlight"] }).Highlight;
  if (cssGlobal?.highlights === undefined || highlightCtor === undefined) return null;
  return { registry: cssGlobal.highlights, Highlight: highlightCtor };
}

/** True when the runtime can paint (Baseline browsers; not jsdom). */
export function canPaintHighlights(): boolean {
  return highlightApi() !== null;
}

/**
 * Replace every highlight under `prefix` with the given groups. A group's
 * `key` becomes the registered name `<prefix>-<key>` — style it with
 * `::highlight(<prefix>-<key>)`.
 */
export function paintHighlights(
  prefix: string,
  groups: { key: string; ranges: Range[] }[],
): boolean {
  const api = highlightApi();
  if (api === null) return false;
  clearHighlights(prefix);
  for (const group of groups) {
    if (group.ranges.length === 0) continue;
    api.registry.set(`${prefix}-${group.key}`, new api.Highlight(...group.ranges));
  }
  return true;
}

export function clearHighlights(prefix: string): void {
  const api = highlightApi();
  if (api === null) return;
  for (const name of [...api.registry.keys()]) {
    if (name.startsWith(`${prefix}-`)) api.registry.delete(name);
  }
}
