import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useIterateSession } from "iterate/sdk/itx/react";

const TAB_KEY_STORAGE = "iterate-os-app-tab-key";

/**
 * One stable key per BROWSER TAB: sessionStorage survives reloads within the
 * tab and is never shared across tabs, so a reload reclaims the same client
 * path while a second tab mints its own.
 */
function tabConnectionKey(): string {
  const existing = window.sessionStorage.getItem(TAB_KEY_STORAGE);
  if (existing !== null) return existing;
  const minted = crypto.randomUUID().slice(0, 8);
  window.sessionStorage.setItem(TAB_KEY_STORAGE, minted);
  return minted;
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
    const tabKey = tabConnectionKey();
    void (async () => {
      try {
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
