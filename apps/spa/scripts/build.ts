import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const output = new URL("../dist/", import.meta.url);
const dist = new URL("assets/", output);
rmSync(output, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(new URL("../public/", import.meta.url), dist, { recursive: true });
execFileSync(
  "python3",
  [
    fileURLToPath(new URL("../../browser-extension/package.py", import.meta.url)),
    fileURLToPath(new URL("downloads/", dist)),
  ],
  { stdio: "inherit" },
);
const manifest = z
  .object({ version: z.string().regex(/^\d+(\.\d+){0,3}$/) })
  .parse(
    JSON.parse(
      readFileSync(new URL("../../browser-extension/manifest.json", import.meta.url), "utf8"),
    ),
  );
writeFileSync(
  new URL("downloads/index.html", dist),
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Iterate Chrome extension</title>
<body style="max-width:40rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.6 system-ui">
<h1>Iterate Chrome extension</h1>
<p><a href="iterate-chrome-extension-${manifest.version}.zip">Download version ${manifest.version}</a></p>
<ol><li>Unzip the download.</li><li>Open <code>chrome://extensions</code> and enable Developer mode.</li>
<li>Choose <strong>Load unpacked</strong> and select the extracted folder.</li></ol>
<p>Updating an existing copy? Replace the files in its installed folder, then click <strong>Reload</strong> on its extension card.
Close and reopen the side panel; the heading shows the installed version. Sign out and sign in again to give the session its client logo.</p>
</body></html>\n`,
);
