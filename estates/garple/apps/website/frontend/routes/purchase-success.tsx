import { useParams } from "react-router";
import { Check } from "lucide-react";
import { Link } from "react-router";

export function PurchaseSuccess() {
  const { domainNameWithTLD } = useParams<{ domainNameWithTLD: string }>();

  if (!domainNameWithTLD) {
    return <div>Domain not found</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      {/* Logo */}
      <div className="flex items-center justify-center space-x-2">
        <Link
          to="/"
          className="inline-block px-3 py-1 bg-green-50 dark:bg-gray-800 border border-green-600 dark:border-green-400 rounded-full"
        >
          <span className="text-green-700 dark:text-green-400 text-sm font-medium">🌱 GARPLE</span>
        </Link>
        <span className="text-gray-500 dark:text-gray-400 text-sm">
          by{" "}
          <a href="https://iterate.com" className="hover:underline">
            iterate
          </a>
        </span>
      </div>

      {/* Header */}
      <div className="text-center space-y-4">
        <div className="w-16 h-16 bg-green-200 dark:bg-green-900 rounded-full flex items-center justify-center mx-auto">
          <Check className="w-8 h-8 text-green-700 dark:text-green-400" />
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
          You're now the proud owner of {domainNameWithTLD}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          You should have received an email with further instructions. If there are any issues,
          email sales@garple.com
        </p>
      </div>

      {/* Footer */}
      <div className="pt-8 border-t border-gray-200 dark:border-gray-700">
        <div className="text-center space-y-2">
          <Link
            to="/"
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 text-sm"
          >
            View our other domains at {window.location.hostname}
          </Link>
          <div className="text-lg">🌱</div>
        </div>
      </div>
    </div>
  );
}
