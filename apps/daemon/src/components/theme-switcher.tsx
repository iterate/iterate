import { useState, useEffect } from "react";
import { Check, Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

const themes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function ThemeSwitcher() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentTheme = themes.find((t) => t.value === theme) || themes[2];
  const ThemeIcon = mounted ? currentTheme.icon : Monitor;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <ThemeIcon className="size-4" />
              <span className="truncate">Theme</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48" side="top" align="start">
            {themes.map((themeOption) => (
              <DropdownMenuItem
                key={themeOption.value}
                onClick={() => setTheme(themeOption.value)}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <themeOption.icon className="size-4" />
                  <span>{themeOption.label}</span>
                </div>
                {theme === themeOption.value && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
