// apps/kit/scripts/config-image.ts — the ITERKIT1 provisioning image for a board provisioned by hand,
// and for `iterate-kit-mac --config`, written by the encoder Kit's browser flashing uses
// (src/firmware/config-image.ts), so a bench board holds the bytes a Kit install would write.
//
//   pnpm --dir apps/kit exec tsx scripts/config-image.ts image --wifi-ssid <ssid> \
//     --wifi-password <password> --os-base-url https://os.iterate.com --project-id prj-voice \
//     --project-api-key "$KIT_TOKEN" [--status-voice greensleeves] --out /tmp/cfg.bin
//   pnpm --dir apps/kit exec tsx scripts/config-image.ts offset <target>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { encodeDeviceConfiguration, isStatusVoice } from "../src/firmware/config-image.ts";

const TARGETS = fileURLToPath(new URL("../firmware/targets", import.meta.url));

/** The iterate_kit partition's size in every partition table (targets/common/partitions-*.csv),
 *  and what iterate-kit-mac reads of its --config file. */
const IMAGE_BYTES = 0x1000;

/** Writes the image to --out, and never prints the key. */
export function image(options: {
  /** Required, though the Mac ignores it. */
  wifiSsid: string;
  /** Empty, the default, for an open network. */
  wifiPassword?: string;
  osBaseUrl: string;
  projectId: string;
  /** A personal access token scoped to the project. */
  projectApiKey: string;
  /** greensleeves (the default), daisy-bell, auld-lang-syne, lass-of-aughrim, spoken or off. */
  statusVoice?: string;
  out: string;
}) {
  const statusVoice = options.statusVoice || "greensleeves";
  if (!isStatusVoice(statusVoice))
    throw new Error(`--status-voice ${statusVoice} is no status voice.`);
  const bytes = encodeDeviceConfiguration(
    {
      wifi: { ssid: options.wifiSsid, password: options.wifiPassword || "" },
      iterate: {
        baseUrl: options.osBaseUrl,
        projectId: options.projectId,
        projectApiKey: options.projectApiKey,
      },
      statusVoice,
    },
    IMAGE_BYTES,
  );
  writeFileSync(options.out, bytes);
  return `wrote ${options.out} (${bytes.byteLength} bytes) for ${options.projectId} @ ${options.osBaseUrl}`;
}

/** Prints the target's iterate_kit offset (its sdkconfig.defaults' partition table): esptool's address. */
export function offset(target: string) {
  const directory = join(TARGETS, target);
  if (!existsSync(join(directory, "sdkconfig.defaults"))) {
    const boards = readdirSync(TARGETS)
      .filter((name) => name !== "common" && existsSync(join(TARGETS, name, "sdkconfig.defaults")))
      .sort();
    throw new Error(`${target} is no board target; the boards are ${boards.join(", ")}.`);
  }
  const table = /^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="([^"]+)"$/m.exec(
    readFileSync(join(directory, "sdkconfig.defaults"), "utf8"),
  )?.[1];
  if (!table) throw new Error(`targets/${target}/sdkconfig.defaults names no partition table.`);
  const row = readFileSync(join(directory, table), "utf8")
    .split("\n")
    .map((line) => line.split(",").map((cell) => cell.trim()))
    .find(([name]) => name === "iterate_kit");
  if (!row?.[3]) throw new Error(`targets/${target}/${table} has no iterate_kit partition.`);
  return row[3];
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "config-image" }).run();
