import Logo from "./Logo.tsx";
import Navigation from "./Navigation.tsx";

export default function SiteHeader() {
  return (
    <header className="border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 py-4">
        <nav className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Logo />
          </div>
          <div className="flex items-center">
            <Navigation />
          </div>
        </nav>
      </div>
    </header>
  );
}
