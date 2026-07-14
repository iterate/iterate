import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@iterate-com/ui/components/sidebar";

/**
 * Idiomatic shadcn mobile sidebar: dismiss the Sheet when the route changes.
 *
 * Stock Sidebar exposes `setOpenMobile` for this (docs) but does not auto-close
 * on navigation — see https://github.com/shadcn-ui/ui/issues/5561. In-sheet
 * link buttons are handled by `SidebarMenuButton`; this covers portaled menu
 * items (project switcher, account menu) that navigate outside the Sheet DOM.
 */
export function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return null;
}
