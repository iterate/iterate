import SymbolIcon from "./Symbol.tsx";
import { Link } from "./Link.tsx";

export default function SiteFooter() {
  return (
    <footer className="mt-8">
      <div className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 py-12">
        <div className="border border-dashed border-gray-300 rounded-none p-4">
          <div className="space-y-3">
            <div className="text-sm">
              <Link to="/blog">Blog</Link>
              <span className="mx-2 text-gray-400">|</span>
              <Link to="/privacy">Privacy</Link>
              <span className="mx-2 text-gray-400">|</span>
              <Link to="/terms">Terms</Link>
            </div>
            <div className="flex items-center gap-2">
              <SymbolIcon />
              <span className="text-sm text-gray-600">
                iterate is a registered trademark of Nustom (UK) Limited.{" "}
                <Link
                  to="https://trademarks.ipo.gov.uk/ipo-tmcase/page/Results/1/UK00004143107"
                  external
                  variant="underline"
                  className="text-sm"
                >
                  UK00004143107
                </Link>
              </span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
