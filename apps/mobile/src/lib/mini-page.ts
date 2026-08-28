// Mini pages: the OS pages that exist to collect one thing from a human and
// then get out of the way — `/collect-secret/...` today, ad-hoc "answer these
// three questions" pages next. Handing them to the system browser makes the
// user leave the app and find their way back, so instead we open them in an
// in-app browser sheet.
//
// The contract (written down on the other side, apps/os/src/lib/mini-page.ts):
// we add a `returnTo` deep link to the URL, and the page navigates to it when
// its job is done. iOS's auth-session browser watches for exactly that — a
// navigation to our own scheme — and dismisses itself, handing the URL back.
// So the sheet closes by itself, and we learn how it went, without knowing
// anything about what the page collected.
//
// Adding a page here is one line in MINI_PAGE_PATHS.

const MINI_PAGE_PATHS = ["/collect-secret"];

/** What a mini page reported when its browser sheet closed. `status` is the
 * page's own outcome vocabulary; `params` carries whatever else it sent. */
export type MiniPageOutcome =
  | { kind: "done"; params: Record<string, string>; status: string | undefined }
  /** The user swiped the sheet away without finishing. */
  | { kind: "dismissed" };

/**
 * The mini page to open in an in-app browser, or null when the link is an
 * ordinary one for the system browser. Only same-origin links resolve — a
 * lookalike host must never get to render inside our sheet, where it would
 * look like part of the app.
 */
export function resolveMiniPageUrl(url: string, context: { baseUrl: string | undefined }) {
  if (!context.baseUrl) return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(context.baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const isMiniPage = MINI_PAGE_PATHS.some(
    (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
  );
  // The link as written, not `parsed.toString()`: these URLs carry
  // JSON-encoded search params, and there is no reason to hand the page a
  // re-encoded version of something it already knows how to read.
  return isMiniPage ? url : null;
}

/** The slice of an in-app browser session's result this contract needs.
 * Declared structurally rather than imported from expo-web-browser so this
 * module — and its test — never pull React Native into a pure-node lane;
 * `WebBrowser.openAuthSessionAsync` satisfies it as-is. */
type BrowserSessionResult = { type: string; url?: string };

/**
 * Open a mini page in the in-app browser and wait for it to finish. The
 * `openAuthSession` opener is injected (it is `WebBrowser.openAuthSessionAsync`
 * in the app) so this stays testable without a native runtime.
 */
export async function openMiniPage(input: {
  openAuthSession: (url: string, returnUrl: string) => Promise<BrowserSessionResult>;
  /** Deep link back into this app — the signal the sheet closes on. */
  returnUrl: string;
  url: string;
}): Promise<MiniPageOutcome> {
  const target = new URL(input.url);
  // `set`, not `append`: a link that arrived with its own `returnTo` gets ours
  // instead of two of them. (The page refuses non-app schemes anyway, but a
  // link nobody signed should not get to choose where the sheet sends you.)
  target.searchParams.set("returnTo", input.returnUrl);
  const result = await input.openAuthSession(target.toString(), input.returnUrl);
  return result.type === "success" && result.url !== undefined
    ? readMiniPageReturn(result.url)
    : { kind: "dismissed" };
}

/** Read the deep link a finished mini page sent us back to. */
export function readMiniPageReturn(returnedUrl: string): MiniPageOutcome {
  let parsed: URL;
  try {
    parsed = new URL(returnedUrl);
  } catch {
    return { kind: "dismissed" };
  }
  const params = Object.fromEntries(parsed.searchParams);
  return { kind: "done", params, status: params.status };
}
