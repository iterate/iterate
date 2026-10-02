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

// public/manifest.json's `key` is a placeholder, which Chrome would refuse. A real key fixes the
// extension's id, and so its sign-in redirect (`https://<id>.chromiumapp.org/`), on every install:
// the zip the SPA serves has iterate's, from envs.ts (packages/spa/scripts/deploy.ts sets
// CHROME_EXTENSION_KEY). Without one the key is removed and Chrome derives the id from the unpacked
// folder's path; sign-in still works, as panel.js registers its redirect with the issuer.
const manifestPath = new URL("manifest.json", dist);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.key = process.env.CHROME_EXTENSION_KEY || undefined;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
