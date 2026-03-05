import SiteHeader from "./site-header.tsx";
import SiteFooter from "./site-footer.tsx";

interface BlogLayoutProps {
  children: React.ReactNode;
}

export default function BlogLayout({ children }: BlogLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <SiteHeader />
      <main className="w-full max-w-7xl mx-auto px-6 sm:px-8 md:px-10 mt-12 sm:mt-24 flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
