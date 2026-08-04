import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@iterate-com/ui/components/sidebar";

/**
 * Idiomatic shadcn mobile sidebar: dismiss the Sheet when navigation happens.
 * The apps/os helper, with one docs twist: every navigation here is a SEARCH
 * change on `/` (`?workspace=&path=`), so it watches the full href — a
 * pathname watcher would never fire.
 *
 * Stock Sidebar exposes `setOpenMobile` for this (docs) but does not
 * auto-close on navigation — see
 * https://github.com/shadcn-ui/ui/issues/5561. In-sheet link buttons are
 * handled by `SidebarMenuButton`; this covers the portaled workspace-switcher
 * menu items that navigate outside the Sheet DOM.
 *
 * Only close when the href actually changes — not on mount. The mobile
 * sidebar renders children inside a Sheet that remounts when opened; an
 * unconditional mount effect would dismiss the sheet as soon as it opens.
 */
export function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const href = useRouterState({ select: (state) => state.location.href });
  const previousHrefRef = useRef(href);

  useEffect(() => {
    if (previousHrefRef.current === href) return;
    previousHrefRef.current = href;
    setOpenMobile(false);
  }, [href, setOpenMobile]);

  return null;
}
