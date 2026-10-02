// dist/ is the unpacked extension (what Load unpacked takes, and what packages/spa's build zips):
// public/, capnweb's browser bundle from node_modules (the catalog's version, the one core/os
// speaks) and the SPA's oauth.js, the one OAuth client both run. README.md says why the extension
// carries its code itself.
import { cpSync, rmSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
cpSync(new URL("../public/", import.meta.url), dist, { recursive: true });
cpSync(new URL(import.meta.resolve("capnweb")), new URL("capnweb.js", dist));
cpSync(new URL("../../spa/public/oauth.js", import.meta.url), new URL("oauth.js", dist));
