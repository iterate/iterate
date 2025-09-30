import { useEffect, useState } from "react";
import { redirect, useLoaderData } from "react-router";
import { ArrowRight, ExternalLink, Clock } from "lucide-react";
import { eq } from "drizzle-orm";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../components/ui/card.tsx";
import { getDb, schema } from "../../backend/db/client.ts";
import { MCPOAuthState } from "../../backend/auth/oauth-state-schemas.ts";
import type { Route } from "./+types/integrations.redirect";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Redirecting - Iterate Dashboard" },
    {
      name: "description",
      content: "You are being redirected to complete your integration setup",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return redirect("/");
  }
  const state = await getDb().query.verification.findFirst({
    where: eq(schema.verification.identifier, key),
  });
  if (!state || state.expiresAt < new Date()) {
    return redirect("/");
  }

  const parsedState = MCPOAuthState.parse(JSON.parse(state.value));
  return {
    redirectUrl: parsedState.fullUrl,
  };
}

export default function IntegrationsRedirect() {
  const { redirectUrl } = useLoaderData<typeof loader>();
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (!redirectUrl) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          window.location.href = redirectUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [redirectUrl]);

  const handleRedirectNow = () => {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="max-w-md mx-auto text-balance">
        <Card>
          <CardHeader className="text-center">
            <div className="w-12 h-12 rounded-lg bg-blue-100 mx-auto mb-4 flex items-center justify-center">
              <ExternalLink className="w-6 h-6 text-blue-600" />
            </div>
            <CardTitle className="flex items-center justify-center gap-2">
              <Clock className="w-5 h-5" />
              Redirecting in {countdown} second{countdown !== 1 ? "s" : ""}
            </CardTitle>
            <CardDescription>
              You will be redirected to the following URL to complete your integration setup:
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="p-3 bg-muted rounded-lg">
              <a
                className="text-sm font-mono break-all text-muted-foreground hover:underline cursor-pointer"
                href={redirectUrl}
                target="_blank"
              >
                {redirectUrl}
              </a>
            </div>

            <div className="space-y-2">
              <Button onClick={handleRedirectNow} className="w-full" size="lg">
                Redirect Now
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  window.history.back();
                }}
                className="w-full"
              >
                Cancel
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center mt-4">
              If you are not redirected automatically, click the "Redirect Now" button above.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
