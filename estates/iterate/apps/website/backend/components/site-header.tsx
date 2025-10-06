import Logo from "./logo.tsx";
import Navigation from "./navigation.tsx";
import MobileNav from "./mobile-nav.tsx";
import CommandMenu from "./command-menu.tsx";
import { ModeToggle } from "./mode-toggle.tsx";
import { GitHubIcon, TwitterIcon } from "./icons.tsx";

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 w-full bg-background">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Logo width={32} height={32} />
          <div className="hidden md:flex">
            <Navigation />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <CommandMenu />
          </div>
          <nav className="flex items-center gap-1">
            <a
              href="https://github.com/iterate-com/iterate"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-9 w-9"
              aria-label="GitHub"
            >
              <GitHubIcon size={16} />
            </a>
            <a
              href="https://x.com/iterate"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-9 w-9"
              aria-label="X (Twitter)"
            >
              <TwitterIcon size={16} />
            </a>
            {/* <ModeToggle /> */}
          </nav>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
