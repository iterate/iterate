import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { LogInWithIterate } from "@iterate-com/ui/components/log-in-with-iterate";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldDescription,
} from "@iterate-com/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { DEFAULT_DEVICE_ID, findFirmwareDevice, firmwareCatalog } from "../firmware/catalog.ts";
import { deviceVendors } from "../firmware/device-client.ts";

export const Route = createFileRoute("/")({
  validateSearch: z.object({ device: z.string().optional().catch(undefined) }),
  head: () => ({ meta: [{ title: "Choose your device · Kit" }] }),
  component: DevicePicker,
});

const deviceItems = firmwareCatalog.map((device) => ({ label: device.name, value: device.id }));

function DevicePicker() {
  const search = Route.useSearch();
  const [deviceId, setDeviceId] = useState(
    findFirmwareDevice(search.device || "")?.id || DEFAULT_DEVICE_ID,
  );
  const device = findFirmwareDevice(deviceId)!;
  const vendor = deviceVendors[device.id]!;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <section className="flex w-full max-w-md flex-col gap-6">
        <header className="flex items-center gap-3">
          <IterateLogo className="size-9" />
          <h1 className="text-xl font-semibold tracking-tight">Set up your device</h1>
        </header>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose your device, then log in to choose its project and authorize access.
        </p>
        <Field>
          <FieldLabel htmlFor="device">Device</FieldLabel>
          <FieldContent>
            <Select
              items={deviceItems}
              value={device.id}
              onValueChange={(value) => {
                if (value) setDeviceId(value);
              }}
            >
              <SelectTrigger id="device" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {deviceItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription className="flex items-center gap-2">
              <img
                src={`/vendors/${vendor.icon}`}
                alt={vendor.name}
                className="size-6 object-contain"
              />
              {device.description}
            </FieldDescription>
          </FieldContent>
        </Field>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each device has its own access to the project you choose. You can revoke its access at any
          time.
        </p>
        <LogInWithIterate formAction={`/devices/${device.id}/login`} />
      </section>
    </main>
  );
}
