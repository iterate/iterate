import { useLocation } from "react-router";
import { cn } from "../utils/cn.ts";
import { Link } from "./link.tsx";

export default function Navigation() {
  const { pathname } = useLocation();
  const navItems = [
    { href: "/docs", label: "Docs" },
    { href: "/changelog", label: "Changelog" },
    { href: "/roadmap", label: "Roadmap" },
    { href: "/blog", label: "Blog" },
  ];

  return (
    <nav className="flex items-center gap-6 text-sm">
      {navItems.map((item) => {
        const isActive = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            variant="none"
            className={cn(
              "transition-colors hover:text-foreground/80",
              isActive ? "text-foreground font-medium" : "text-foreground/60",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
