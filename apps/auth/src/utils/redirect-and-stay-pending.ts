/**
 * Leave the page and keep the caller's mutation pending until the browser
 * actually unloads. A bare `window.location.href = ...` returns immediately,
 * react-query flips `isPending` off, and every `isSubmitting`-gated button
 * re-enables mid-navigation — "Create project" then invites a double submit,
 * and pending labels ("Authorizing...", "Signing in...") flicker back to
 * their idle text while the slow server round trip is still in flight,
 * leaving the page with no visible loading state. Returning this
 * never-resolving promise (from `onSuccess`, or awaited in a `mutationFn`)
 * keeps the mutation pending for the page's remaining lifetime.
 */
export function redirectAndStayPending(href: string): Promise<never> {
  window.location.href = href;
  return new Promise<never>(() => {});
}
