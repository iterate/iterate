import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { SCREEN_FONT_CSS } from "./screen-font.ts";

test("the stored screen font CSS is assets/pixel-font.css with its font embedded", async () => {
  const assets = new URL("../assets/", import.meta.url);
  const css = await readFile(new URL("pixel-font.css", assets), "utf8");
  const font = await readFile(new URL("press-start-2p-ascii.woff2", assets));
  expect(SCREEN_FONT_CSS).toBe(
    css.replace(
      'url("./press-start-2p-ascii.woff2")',
      `url("data:font/woff2;base64,${Buffer.from(font).toString("base64")}")`,
    ),
  );
});
