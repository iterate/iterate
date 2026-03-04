import { z } from "zod/v4";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
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
  const { userCode, userName } = Route.useLoaderData();

  const approve = useMutation({
    mutationFn: () => authClient.device.approve({ userCode, fetchOptions: { throw: true } }),
  });

  const deny = useMutation({
    mutationFn: () => authClient.device.deny({ userCode, fetchOptions: { throw: true } }),
    onError: (err: Error) => toast.error(err.message || "Failed to deny device"),
  });

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

  if (approve.isSuccess) {
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

  if (deny.isSuccess) {
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

  const busy = approve.isPending || deny.isPending;

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

            {approve.error && (
              <p className="text-sm text-destructive text-center">{approve.error.message}</p>
            )}

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => deny.mutate()}
                disabled={busy}
              >
                Deny
              </Button>
              <Button className="flex-1" onClick={() => approve.mutate()} disabled={busy}>
                {approve.isPending ? "Authorizing..." : "Authorize"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </CenteredLayout>
  );
}
