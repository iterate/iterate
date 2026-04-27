import type React from "react";
import { z } from "zod/v4";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "../utils/auth-client.ts";

const ensureAuthForDevice = createServerFn({ method: "GET" })
  .inputValidator(z.object({ user_code: z.string().optional() }))
  .handler(({ context, data }) => {
    const userCode = data.user_code || "";
    if (!context.variables.session) {
      const deviceUrl = `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`;
      throw redirect({
        to: "/login",
        search: { redirect: deviceUrl },
      });
    }
    return { userCode, userName: context.variables.session.user.name };
  });

export const Route = createFileRoute("/device")({
  component: DevicePage,
  validateSearch: z.object({
    user_code: z.string().optional(),
  }),
  loaderDeps: ({ search }) => ({ user_code: search.user_code }),
  loader: ({ deps }) => ensureAuthForDevice({ data: deps }),
});

type Tone = "muted" | "success" | "destructive";

const TONE_CLASSES: Record<Tone, string> = {
  muted: "border text-muted-foreground",
  success: "border-green-500 text-green-500",
  destructive: "border-destructive text-destructive",
};

function DeviceCard({
  badge,
  badgeTone = "muted",
  title,
  children,
}: {
  badge: string;
  badgeTone?: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border p-6">
        <div className="text-center">
          <div
            className={`mx-auto flex h-10 w-10 items-center justify-center rounded-full text-sm ${TONE_CLASSES[badgeTone]}`}
          >
            {badge}
          </div>
          <h1 className="mt-4 text-xl font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

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
      <DeviceCard badge="CLI" title="Device Authorization">
        <p className="mt-2 text-center text-sm text-muted-foreground">
          No device code provided. Run <code className="text-sm">iterate login</code> in your
          terminal and follow the instructions.
        </p>
      </DeviceCard>
    );
  }

  if (approve.isSuccess) {
    return (
      <DeviceCard badge="OK" badgeTone="success" title="CLI Authorized">
        <p className="mt-2 text-center text-sm text-muted-foreground">
          You have authorized the Iterate CLI. You can close this tab and return to your terminal.
        </p>
      </DeviceCard>
    );
  }

  if (deny.isSuccess) {
    return (
      <DeviceCard badge="NO" badgeTone="destructive" title="Authorization Denied">
        <p className="mt-2 text-center text-sm text-muted-foreground">
          The CLI authorization request was denied. You can close this tab.
        </p>
      </DeviceCard>
    );
  }

  const busy = approve.isPending || deny.isPending;

  return (
    <DeviceCard badge="CLI" title="Authorize CLI">
      <p className="mt-2 text-center text-sm text-muted-foreground">
        The Iterate CLI is requesting access to your account
        {userName ? ` (${userName})` : ""}.
      </p>

      <div className="mt-6 rounded-lg border bg-muted/50 p-4 text-center">
        <p className="mb-1 text-sm text-muted-foreground">
          Confirm this code matches your terminal
        </p>
        <p className="font-mono text-2xl font-bold tracking-widest">{userCode}</p>
      </div>

      {approve.error && (
        <p className="mt-4 text-center text-sm text-destructive">{approve.error.message}</p>
      )}

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          className="flex-1 rounded-md border px-4 py-2"
          onClick={() => deny.mutate()}
          disabled={busy}
        >
          Deny
        </button>
        <button
          type="button"
          className="flex-1 rounded-md bg-black px-4 py-2 text-white"
          onClick={() => approve.mutate()}
          disabled={busy}
        >
          {approve.isPending ? "Authorizing..." : "Authorize"}
        </button>
      </div>
    </DeviceCard>
  );
}
