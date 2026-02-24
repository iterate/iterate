import { z } from "zod/v4";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AlertCircle } from "lucide-react";
import { LoginCard } from "../components/auth-components.tsx";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";

function normalizeRedirectUrl(redirectUrl: string | undefined): string {
  if (!redirectUrl) return "/";
  return redirectUrl.startsWith("/") ? redirectUrl : "/";
}
const resolveLoginRedirectUrl = createServerFn({ method: "GET" })
  .inputValidator(z.object({ redirectUrl: z.string().optional() }))
  .handler(({ context, data }) => {
    const redirectUrl = normalizeRedirectUrl(data.redirectUrl);
    if (context.variables.session) throw redirect({ to: redirectUrl });
    return redirectUrl;
  });

/** Extract error from URL - either direct param or embedded in redirectUrl */
function extractError(error: string | undefined, redirectUrl: string): string | undefined {
  if (error) return error;
  // Check if error is embedded in redirectUrl (e.g., "/?error=Some_error")
  try {
    const url = new URL(redirectUrl, "http://localhost");
    return url.searchParams.get("error") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Convert error code to human-readable message */
function formatErrorMessage(error: string): string {
  return error.replace(/_/g, " ");
}

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: z.object({
    redirectUrl: z.string().optional(),
    error: z.string().optional(),
  }),
  loaderDeps: ({ search }) => ({ redirectUrl: search.redirectUrl }),
  loader: ({ deps }) => resolveLoginRedirectUrl({ data: deps }),
});

function LoginPage() {
  const { error } = Route.useSearch();
  const redirectUrl = Route.useLoaderData();
  const errorMessage = extractError(error, redirectUrl);

  return (
    <CenteredLayout>
      <div className="w-full max-w-md space-y-6">
        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{formatErrorMessage(errorMessage)}</AlertDescription>
          </Alert>
        )}
        <LoginCard redirectUrl={redirectUrl} />
      </div>
    </CenteredLayout>
  );
}
