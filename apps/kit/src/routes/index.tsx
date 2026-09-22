import { createFileRoute } from "@tanstack/react-router";
import { LogInWithIterate } from "@iterate-com/ui/components/log-in-with-iterate";
import { DEFAULT_DEVICE_ID, DEFAULT_FIRMWARE_VERSION } from "../firmware/catalog.ts";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Sign in · Kit" }] }),
  component: () => (
    <main className="flex min-h-svh items-center justify-center p-6">
      <LogInWithIterate
        next={`/devices/${DEFAULT_DEVICE_ID}/firmware/${DEFAULT_FIRMWARE_VERSION}`}
        scopes={["iterate", "account"]}
      />
    </main>
  ),
});
