import { useLocation } from "react-router";
import { FileText } from "lucide-react";
import { Link } from "./Link.tsx";

export default function Navigation() {
  const { pathname } = useLocation();
  const navItems = [
    // { href: "/#pricing", label: "Pricing" }, // hidden for now
    { href: "/blog", icon: FileText, ariaLabel: "Blog" },
  ];

  return (
    <nav className="flex items-center gap-4 sm:gap-6 text-sm flex-wrap">
      {navItems.map((item) => {
        const isActive = pathname.startsWith(item.href.replace("/#", "/"));
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            to={item.href}
            variant="subtle"
            className="font-medium"
            aria-current={isActive ? "page" : undefined}
            aria-label={item.ariaLabel}
          >
            {Icon ? <Icon size={18} /> : item.ariaLabel}
          </Link>
        );
      })}
    </nav>
  );
}
