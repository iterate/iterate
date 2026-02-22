import { useState } from "react";
import { z } from "zod/v4";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { CheckCircle, Monitor, XCircle } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "../lib/auth-client.ts";
import { CenteredLayout } from "../components/centered-layout.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";

/**
 * Server function: if not authenticated, redirect to login with a return URL
 * that preserves the user_code. If authenticated, return the user code.
 */
const ensureAuthForDevice = createServerFn({ method: "GET" })
  .inputValidator(z.object({ user_code: z.string().optional() }))
  .handler(({ context, data }) => {
    const userCode = data.user_code || "";
    if (!context.variables.session) {
      const deviceUrl = `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`;
      throw redirect({
        to: "/login",
        search: { redirectUrl: deviceUrl },
      });
    }
    return { userCode, userName: context.variables.session.user.name };
  });

export const Route = createFileRoute("/device" as any)({
  component: DevicePage,
  validateSearch: z.object({
    user_code: z.string().optional(),
  }),
  loaderDeps: ({ search }) => ({ user_code: search.user_code }),
  loader: ({ deps }) => ensureAuthForDevice({ data: deps }),
});

function DevicePage() {
  const { userCode, userName } = Route.useLoaderData() as { userCode: string; userName: string };
  const [status, setStatus] = useState<"idle" | "approving" | "approved" | "denied" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleApprove = async () => {
    if (!userCode) {
      toast.error("No device code provided");
      return;
    }
    setStatus("approving");
    try {
      await (authClient as any).device.approve({
        userCode,
        fetchOptions: { throw: true },
      });
      setStatus("approved");
    } catch (err: any) {
      setStatus("error");
      const message = err?.message || "Failed to approve device";
      setErrorMessage(message);
      toast.error(message);
    }
  };

  const handleDeny = async () => {
    if (!userCode) return;
    try {
      await (authClient as any).device.deny({
        userCode,
        fetchOptions: { throw: true },
      });
      setStatus("denied");
    } catch (err: any) {
      toast.error(err?.message || "Failed to deny device");
    }
  };

  if (!userCode) {
    return (
      <CenteredLayout>
        <div className="w-full max-w-md">
          <Card>
            <CardHeader className="text-center">
              <Monitor className="mx-auto h-10 w-10 text-muted-foreground" />
              <CardTitle className="mt-4">Device Authorization</CardTitle>
              <CardDescription>
                No device code provided. Run <code className="text-sm">iterate login</code> in your
                terminal and follow the instructions.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </CenteredLayout>
    );
  }

  if (status === "approved") {
    return (
      <CenteredLayout>
        <div className="w-full max-w-md">
          <Card>
            <CardHeader className="text-center">
              <CheckCircle className="mx-auto h-10 w-10 text-green-500" />
              <CardTitle className="mt-4">CLI Authorized</CardTitle>
              <CardDescription>
                You have authorized the Iterate CLI. You can close this tab and return to your
                terminal.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </CenteredLayout>
    );
  }

  if (status === "denied") {
    return (
      <CenteredLayout>
        <div className="w-full max-w-md">
          <Card>
            <CardHeader className="text-center">
              <XCircle className="mx-auto h-10 w-10 text-destructive" />
              <CardTitle className="mt-4">Authorization Denied</CardTitle>
              <CardDescription>
                The CLI authorization request was denied. You can close this tab.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </CenteredLayout>
    );
  }

  return (
    <CenteredLayout>
      <div className="w-full max-w-md">
        <Card>
          <CardHeader className="text-center">
            <Monitor className="mx-auto h-10 w-10 text-muted-foreground" />
            <CardTitle className="mt-4">Authorize CLI</CardTitle>
            <CardDescription>
              The Iterate CLI is requesting access to your account
              {userName ? ` (${userName})` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-lg border bg-muted/50 p-4 text-center">
              <p className="text-sm text-muted-foreground mb-1">
                Confirm this code matches your terminal
              </p>
              <p className="font-mono text-2xl font-bold tracking-widest">{userCode}</p>
            </div>

            {errorMessage && <p className="text-sm text-destructive text-center">{errorMessage}</p>}

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleDeny}
                disabled={status === "approving"}
              >
                Deny
              </Button>
              <Button className="flex-1" onClick={handleApprove} disabled={status === "approving"}>
                {status === "approving" ? "Authorizing..." : "Authorize"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </CenteredLayout>
  );
}
