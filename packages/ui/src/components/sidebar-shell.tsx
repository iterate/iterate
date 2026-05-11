import type { ComponentProps, ReactNode } from "react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "./sidebar.tsx";

type SidebarShellProps = ComponentProps<typeof Sidebar> & {
  header?: ReactNode;
  footer?: ReactNode;
};

export function SidebarShell({ header, footer, children, ...props }: SidebarShellProps) {
  return (
    <Sidebar {...props}>
      {header ? <SidebarHeader>{header}</SidebarHeader> : null}
      <SidebarContent>{children}</SidebarContent>
      {footer ? <SidebarFooter>{footer}</SidebarFooter> : null}
    </Sidebar>
  );
}
