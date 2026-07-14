import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSourceRoot = resolve(import.meta.dirname, "..");
const appRoutesRoot = resolve(appSourceRoot, "routes/_app");

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("stream page route metadata", () => {
  it("marks every stream-breadcrumb route before its client-only loader runs", () => {
    const missingStaticMarker = routeFiles(appRoutesRoot)
      .filter((path) => readFileSync(path, "utf8").includes("streamBreadcrumb("))
      .filter((path) => !readFileSync(path, "utf8").includes("staticData: streamPageStaticData()"))
      .map((path) => relative(appSourceRoot, path));

    expect(missingStaticMarker).toEqual([]);
  });
});
