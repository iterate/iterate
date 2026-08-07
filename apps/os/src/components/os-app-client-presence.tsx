import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useIterateSession } from "iterate/sdk/itx/react";

const TAB_KEY_STORAGE = "iterate-os-app-tab-key";
const TAB_KEY_CHANNEL = "iterate-os-app-tab-keys";
/** How long a probe waits for a live holder to answer before trusting the stored key. */
const TAB_KEY_PROBE_MS = 150;

/**
 * One stable key per BROWSER TAB: sessionStorage survives reloads within the
 * tab (a reload reclaims the same client path) while a fresh tab mints its
 * own. The subtlety: DUPLICATING a tab copies sessionStorage, so the stored
 * key may already belong to a live sibling — two tabs would collapse into one
 * client, the newer capability replacing the older. Every holder therefore
 * answers claims on a BroadcastChannel, and a loading tab probes its stored
 * key first: answered → duplicated tab, mint fresh; silence → reload, reuse.
 */
async function tabConnectionKey(): Promise<string> {
  const stored = window.sessionStorage.getItem(TAB_KEY_STORAGE);
  if (stored !== null && !(await keyHeldByAnotherTab(stored))) {
    holdTabKey(stored);
    return stored;
  }
  const minted = crypto.randomUUID().slice(0, 8);
  window.sessionStorage.setItem(TAB_KEY_STORAGE, minted);
  holdTabKey(minted);
  return minted;
}

/** Probe the channel: does a live tab already hold this key? */
function keyHeldByAnotherTab(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(TAB_KEY_CHANNEL);
    const timer = window.setTimeout(() => {
      channel.close();
      resolve(false);
    }, TAB_KEY_PROBE_MS);
    channel.onmessage = (event) => {
      if (event.data?.type === "held" && event.data.key === key) {
        window.clearTimeout(timer);
        channel.close();
        resolve(true);
      }
    };
    channel.postMessage({ type: "probe", key });
  });
}

/** Answer probes for this tab's key for the rest of the page's life. */
function holdTabKey(key: string): void {
  const channel = new BroadcastChannel(TAB_KEY_CHANNEL);
  channel.onmessage = (event) => {
    if (event.data?.type === "probe" && event.data.key === key) {
      channel.postMessage({ type: "held", key });
    }
  };
}

/**
 * Connect THIS dashboard tab as a project client at
 * `/clients/os-app/<tab-key>`: presence in `itx.clients.list()` plus a live
 * browser capability any project caller (agent scripts, the REPL, other
 * sessions) can drive — `capabilities.browser.navigate(to)` routes the tab
 * through the SPA router, `reload()` reloads it, `url()` reports where it is.
 *
 * The provision's lifetime is the session socket's: the connected project
 * stub is held for the socket's life and disposed on cleanup, which revokes
 * the mount and flips the catalog to disconnected — the platform does the
 * same when the socket dies without a goodbye. `useIterateSession` returns a
 * NEW session identity per reconnect, so the effect re-connects presence on
 * every socket generation. Best-effort by design: a failed connect logs and
 * the dashboard renders exactly as before.
 */
export function OsAppClientPresence({ slug }: { slug: string }) {
  const session = useIterateSession();
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let held: Partial<Disposable> | undefined;
    void (async () => {
      try {
        const tabKey = await tabConnectionKey();
        const project = (await session.projects.connect(slug, {
          path: `/clients/os-app/${tabKey}`,
          description: `OS dashboard tab ${tabKey}`,
          capabilities: {
            browser: {
              navigate: async (to: string) => {
                await router.navigate({ to: to as never });
                return { navigated: to };
              },
              reload: () => {
                window.location.reload();
                return { reloaded: true };
              },
              url: () => window.location.href,
            },
          },
        })) as Partial<Disposable>;
        if (cancelled) project[Symbol.dispose]?.();
        else held = project;
      } catch (error) {
        console.warn("[os-app-client] presence connect failed (dashboard unaffected)", error);
      }
    })();
    return () => {
      cancelled = true;
      held?.[Symbol.dispose]?.();
    };
  }, [session, slug, router]);
  return null;
}
