"use client";

import * as React from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./sidebar.tsx";

type ThemeOption = {
  value: "light" | "dark" | "system";
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
};

const themeOptions: ThemeOption[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

export function SidebarThemeSwitcher() {
  const [mounted, setMounted] = React.useState(false);
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const selectedTheme = mounted && theme ? theme : "system";
  const activeOption =
    themeOptions.find((themeOption) => themeOption.value === selectedTheme) ?? themeOptions[2];
  const ActiveIcon = activeOption.icon;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground">
                <ActiveIcon />
                <span className="truncate">Theme</span>
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent side="top" align="start" className="w-40">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={selectedTheme} onValueChange={setTheme}>
                {themeOptions.map((themeOption) => {
                  const ThemeIcon = themeOption.icon;

                  return (
                    <DropdownMenuRadioItem key={themeOption.value} value={themeOption.value}>
                      <ThemeIcon />
                      <span>{themeOption.label}</span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
