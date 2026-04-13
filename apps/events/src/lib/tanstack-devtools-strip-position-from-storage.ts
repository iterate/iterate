/**
 * @tanstack/devtools applies `tanstack_devtools_settings` from localStorage *after* the
 * `config` prop when building initial state, so a previously saved `position` overrides
 * `config={{ position: "bottom-left" }}` on the React component.
 *
 * Dropping `position` from persisted settings before the devtools mount runs lets the
 * merged `config.position` from `<TanStackDevtools />` take effect. Other settings keep
 * being persisted as usual.
 */
function stripTanStackDevtoolsPositionFromStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = "tanstack_devtools_settings";
    const raw = localStorage.getItem(key);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!("position" in parsed)) {
      return;
    }
    const { position: _removed, ...rest } = parsed;
    localStorage.setItem(key, JSON.stringify(rest));
  } catch {
    // ignore corrupt storage
  }
}

stripTanStackDevtoolsPositionFromStorage();
