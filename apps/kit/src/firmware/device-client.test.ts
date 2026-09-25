import { expect, test } from "vitest";
import { firmwareCatalog } from "./catalog.ts";
import { deviceClientMetadata, deviceVendors } from "./device-client.ts";

test.for(firmwareCatalog)(
  "$name has a distinct client per unit and its vendor artwork",
  async (device) => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const clients = await Promise.all(
      ids.map(async (id) => {
        const url = new URL(`https://k.iterate.com/devices/${device.id}/clients/${id}.json`);
        const response = deviceClientMetadata(url)!;
        expect(response).toMatchObject({ status: 200 });
        const metadata = (await response.json()) as { client_id: string };
        expect(metadata).toMatchObject({
          client_id: url.href,
          client_name: device.name,
          logo_uri: `https://k.iterate.com/vendors/${deviceVendors[device.id]!.icon}`,
          redirect_uris: ["https://k.iterate.com/.auth/callback"],
          token_endpoint_auth_method: "none",
        });
        return metadata;
      }),
    );
    expect(clients[0]).not.toMatchObject({ client_id: clients[1].client_id });
  },
);

test("unrelated routes are left alone and unknown models are refused", () => {
  expect(deviceClientMetadata(new URL("https://k.iterate.com/.auth/login"))).toBeNull();
  expect(
    deviceClientMetadata(
      new URL(
        "https://k.iterate.com/devices/missing/clients/11111111-1111-4111-8111-111111111111.json",
      ),
    )?.status,
  ).toBe(404);
});
