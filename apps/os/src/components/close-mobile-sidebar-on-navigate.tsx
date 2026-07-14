import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@iterate-com/ui/components/sidebar";

/**
 * Idiomatic shadcn mobile sidebar: dismiss the Sheet when the route changes.
 *
 * Stock Sidebar exposes `setOpenMobile` for this (docs) but does not auto-close
 * on navigation — see https://github.com/shadcn-ui/ui/issues/5561. In-sheet
 * link buttons are handled by `SidebarMenuButton`; this covers portaled menu
 * items (project switcher, account menu) that navigate outside the Sheet DOM.
 *
 * Only close when `pathname` actually changes — not on mount. The mobile
 * sidebar renders children inside a Sheet that remounts when opened; an
 * unconditional mount effect would dismiss the sheet as soon as it opens.
 */
export function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return null;
}
