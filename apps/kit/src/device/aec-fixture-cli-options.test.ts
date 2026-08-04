import { describe, expect, test } from "vitest";
import { parseAecFixtureCliOptions } from "./aec-fixture-cli-options.ts";

describe("AEC fixture CLI options", () => {
  test("defaults to an authenticated tunnels.iterate.com fixture", () => {
    expect(
      parseAecFixtureCliOptions([], {
        CAPTUN_TOKEN: " scoped-token ",
        ITERATE_KIT_DEVICE_HOST: "192.168.0.33",
      }),
    ).toEqual({
      captunToken: "scoped-token",
      deviceHost: "192.168.0.33",
      directLanHost: undefined,
      directLanPort: undefined,
      gateway: "https://tunnels.iterate.com",
      tunnelName: undefined,
    });
  });

  test("accepts an explicit direct-LAN isolation route without a Captun token", () => {
    expect(
      parseAecFixtureCliOptions(
        ["--direct-lan-host", "192.168.0.10", "--direct-lan-port", "34567"],
        {},
      ),
    ).toEqual({
      captunToken: undefined,
      deviceHost: undefined,
      directLanHost: "192.168.0.10",
      directLanPort: 34_567,
      gateway: "https://tunnels.iterate.com",
      tunnelName: undefined,
    });
  });

  test("requires both public gateway auth and explicit device attribution", () => {
    expect(() => parseAecFixtureCliOptions([], {})).toThrow(/CAPTUN_TOKEN/u);
    expect(() => parseAecFixtureCliOptions([], { CAPTUN_TOKEN: "token" })).toThrow(/device-host/u);
  });

  test("rejects ambiguous and unsafe transport options", () => {
    expect(() =>
      parseAecFixtureCliOptions(
        ["--direct-lan-host", "192.168.0.10", "--tunnel-name", "ambiguous"],
        {},
      ),
    ).toThrow(/cannot be combined/u);
    expect(() => parseAecFixtureCliOptions(["--direct-lan-port", "34567"], {})).toThrow(
      /direct-lan-host/u,
    );
    expect(() =>
      parseAecFixtureCliOptions([], {
        CAPTUN_GATEWAY: "https://tunnels.iterate.com/path",
        CAPTUN_TOKEN: "token",
        ITERATE_KIT_DEVICE_HOST: "192.168.0.33",
      }),
    ).toThrow(/origin/u);
  });
});
