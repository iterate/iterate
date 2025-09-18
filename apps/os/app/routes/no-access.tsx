import { Link } from "react-router";
import { AlertCircle, Home } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { authClient } from "../lib/auth-client.ts";

export default function NoAccess() {
  const handleLogout = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/login";
        },
      },
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full px-6 py-8">
        <div className="text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/20 mb-4">
            <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
          </div>

          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Access Denied</h1>

          <p className="text-gray-600 dark:text-gray-400 mb-6">
            You don't have access to any estates. This might be because:
          </p>

          <ul className="text-left text-sm text-gray-600 dark:text-gray-400 mb-8 space-y-2">
            <li className="flex items-start">
              <span className="mr-2">•</span>
              <span>Your account hasn't been assigned to an organization yet</span>
            </li>
            <li className="flex items-start">
              <span className="mr-2">•</span>
              <span>Your organization doesn't have any estates configured</span>
            </li>
            <li className="flex items-start">
              <span className="mr-2">•</span>
              <span>There's a temporary issue with the system</span>
            </li>
          </ul>

          <div className="space-y-3">
            <Link to="/">
              <Button variant="default" className="w-full">
                <Home className="mr-2 h-4 w-4" />
                Try Again
              </Button>
            </Link>

            <Button variant="outline" className="w-full" onClick={handleLogout}>
              Sign Out
            </Button>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-500 mt-6">
            If you believe this is an error, please contact your administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
