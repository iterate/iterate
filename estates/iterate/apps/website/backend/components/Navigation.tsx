import { useLocation } from "react-router";
import { Link } from "./Link.tsx";

export default function Navigation() {
  const { pathname } = useLocation();
  const navItems = [
    // { href: "/#pricing", label: "Pricing" }, // hidden for now
    { href: "/blog", label: "Blog" },
  ];

  return (
    <nav className="flex items-center gap-4 sm:gap-6 text-sm flex-wrap">
      {navItems.map((item) => {
        const isActive = pathname.startsWith(item.href.replace("/#", "/"));
        return (
          <Link
            key={item.href}
            to={item.href}
            variant={isActive ? "underline" : "default"}
            className="font-medium"
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
