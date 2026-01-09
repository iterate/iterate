import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Home, Info, Menu, Settings, X } from "lucide-react";

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);

  const linkClass = "flex items-center gap-3 p-3 rounded-lg hover:bg-accent transition-colors";
  const activeLinkClass =
    "flex items-center gap-3 p-3 rounded-lg bg-primary text-primary-foreground transition-colors";

  return (
    <>
      <header className="p-4 flex items-center border-b">
        <button
          onClick={() => setIsOpen(true)}
          className="p-2 hover:bg-accent rounded-lg transition-colors"
          aria-label="Open menu"
        >
          <Menu size={24} />
        </button>
        <Link to="/" className="ml-4 text-xl font-semibold">
          TanStack Start
        </Link>
      </header>

      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-background border-r shadow-lg z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <span className="text-lg font-semibold">Navigation</span>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 hover:bg-accent rounded-lg transition-colors"
            aria-label="Close menu"
          >
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 p-4 flex flex-col gap-1">
          <Link
            to="/"
            onClick={() => setIsOpen(false)}
            className={linkClass}
            activeProps={{ className: activeLinkClass }}
          >
            <Home size={20} />
            <span>Home</span>
          </Link>

          <Link
            to="/about"
            onClick={() => setIsOpen(false)}
            className={linkClass}
            activeProps={{ className: activeLinkClass }}
          >
            <Info size={20} />
            <span>About</span>
          </Link>

          <Link
            to="/settings"
            onClick={() => setIsOpen(false)}
            className={linkClass}
            activeProps={{ className: activeLinkClass }}
          >
            <Settings size={20} />
            <span>Settings</span>
          </Link>
        </nav>
      </aside>

      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setIsOpen(false)} />
      )}
    </>
  );
}
