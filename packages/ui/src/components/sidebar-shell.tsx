import type { ComponentProps, ReactNode } from "react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from "./sidebar.tsx";

type SidebarShellProps = ComponentProps<typeof Sidebar> & {
  header?: ReactNode;
  footer?: ReactNode;
};

export function SidebarShell({
  header,
  footer,
  children,
  collapsible = "icon",
  ...props
}: SidebarShellProps) {
  return (
    <Sidebar collapsible={collapsible} {...props}>
      {header ? <SidebarHeader>{header}</SidebarHeader> : null}
      <SidebarContent>{children}</SidebarContent>
      {footer ? <SidebarFooter>{footer}</SidebarFooter> : null}
      <SidebarRail />
    </Sidebar>
  );
}
