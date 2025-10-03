import Logo from "./Logo.tsx";
import Navigation from "./Navigation.tsx";
import { GitHubIcon } from "./Icons.tsx";

export default function SiteHeader() {
  return (
    <header className="border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 py-4">
        <nav className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Logo />
          </div>
          <div className="flex items-center gap-4">
            <Navigation />
            <a
              href="https://github.com/iterate-com/iterate"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-600 hover:text-gray-900 transition-colors"
              aria-label="View source on GitHub"
            >
              <GitHubIcon size={20} />
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}
