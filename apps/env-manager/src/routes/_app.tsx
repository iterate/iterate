import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <Link to="/environments/" className="flex items-center gap-2 font-medium tracking-tight">
            <img src={iterateLogoAsset} alt="" className="size-6" />
            Environment manager
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
