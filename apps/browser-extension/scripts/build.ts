// dist/ is the unpacked extension (what Load unpacked takes, and what apps/spa's build zips):
// public/ plus capnweb's browser bundle from node_modules, so it is the catalog's version, the one
// apps/os speaks. README.md says why the extension carries capnweb itself.
import { cpSync, rmSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
cpSync(new URL("../public/", import.meta.url), dist, { recursive: true });
cpSync(new URL(import.meta.resolve("capnweb")), new URL("capnweb.js", dist));
