// dist/ is the unpacked extension (what Load unpacked takes, and what packages/spa's build zips):
// public/, capnweb's browser bundle from node_modules (the catalog's version, the one core/os
// speaks) and the SPA's oauth.js, the one OAuth client both run. README.md says why the extension
// carries its code itself.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
cpSync(new URL("../public/", import.meta.url), dist, { recursive: true });
cpSync(new URL(import.meta.resolve("capnweb")), new URL("capnweb.js", dist));
cpSync(new URL("../../spa/public/oauth.js", import.meta.url), new URL("oauth.js", dist));

// A manifest `key` fixes the extension's id, and so its sign-in redirect
// (`https://<id>.chromiumapp.org/`), on every install. The zip the SPA serves has iterate's, from
// envs.ts (packages/spa/scripts/deploy.ts sets CHROME_EXTENSION_KEY). Without one Chrome derives the
// id from the unpacked folder's path, and sign-in still works: panel.js registers its redirect with
// the issuer when it signs in.
if (process.env.CHROME_EXTENSION_KEY) {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dist), "utf8"));
  writeFileSync(
    new URL("manifest.json", dist),
    `${JSON.stringify({ ...manifest, key: process.env.CHROME_EXTENSION_KEY }, null, 2)}\n`,
  );
}
