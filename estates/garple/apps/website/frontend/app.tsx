import "./app.css";
import { BrowserRouter, Routes, Route } from "react-router";
import { QueryProvider } from "./providers.tsx";
import { ModeToggle } from "./components/mode-toggle.tsx";
import { Home } from "./routes/index.tsx";
import { DomainDetails } from "./routes/domain-details.tsx";
import { PurchaseSuccess } from "./routes/purchase-success.tsx";
import { initPostHog } from "./posthog.ts";

initPostHog();

export default function App() {
  return (
    <BrowserRouter>
      <QueryProvider>
        <div className="h-screen overflow-hidden bg-white dark:bg-gray-900">
          <div className="absolute top-4 right-6 z-10">
            <ModeToggle />
          </div>
          <div className="h-full overflow-y-scroll scrollbar-gutter-stable pr-2">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/d/:domainNameWithTLD" element={<DomainDetails />} />
              <Route path="/domains/:domainNameWithTLD/success" element={<PurchaseSuccess />} />
            </Routes>
          </div>
        </div>
      </QueryProvider>
    </BrowserRouter>
  );
}
