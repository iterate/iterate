import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listPreviewAppDopplerProjects,
  listPreviewManagedDopplerProjects,
  previewDopplerConfigName,
} from "./preview-doppler-projects.ts";

describe("previewDopplerConfigName", () => {
  it("formats numbered preview configs", () => {
    assert.equal(previewDopplerConfigName(1), "preview_1");
  });
});

describe("listPreviewManagedDopplerProjects", () => {
  it("includes _shared and every preview app project", () => {
    assert.deepEqual(listPreviewManagedDopplerProjects(), [
      "_shared",
      ...listPreviewAppDopplerProjects(),
    ]);
    assert.ok(listPreviewAppDopplerProjects().includes("os"));
    assert.ok(listPreviewAppDopplerProjects().includes("events"));
  });
});
