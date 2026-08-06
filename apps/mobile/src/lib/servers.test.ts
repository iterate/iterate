import { expect, test } from "vitest";
import { DEFAULT_SERVER, serverPresetForEnvKey } from "./servers.ts";

// The deep link's `env` param must only ever resolve to a preset — a crafted
// link naming anything else (or smuggling a URL) degrades to null and the
// link becomes a plain channel switch.
test("recommended-backend env keys resolve only to known presets", () => {
  expect(serverPresetForEnvKey("preview_12")).toMatchObject({
    baseUrl: "https://os.iterate-preview-12.com",
  });
  expect(serverPresetForEnvKey("prd")).toMatchObject({ baseUrl: DEFAULT_SERVER });
  expect(serverPresetForEnvKey("dev")).toBeNull();
  expect(serverPresetForEnvKey("preview_9999")).toBeNull();
  expect(serverPresetForEnvKey("https://evil.example.com")).toBeNull();
  expect(serverPresetForEnvKey("")).toBeNull();
});
