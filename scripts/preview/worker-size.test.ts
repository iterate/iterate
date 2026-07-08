import { describe, expect, it } from "vitest";
import {
  formatKib,
  formatWorkerSizeStatusDescription,
  parseWorkerSizeFromDeployOutput,
  parseWorkerSizeStatusDescription,
  renderWorkerSizeCell,
  workerSizeStatusContext,
} from "./worker-size.ts";

describe("parseWorkerSizeFromDeployOutput", () => {
  it("parses wrangler's Total Upload line", () => {
    expect(
      parseWorkerSizeFromDeployOutput(
        [
          "Uploaded os-preview-2 (12.34 sec)",
          "Total Upload: 91234.56 KiB / gzip: 3456.78 KiB",
          "Deployed os-preview-2 triggers (0.5 sec)",
        ].join("\n"),
      ),
    ).toEqual({ totalKib: 91234.56, gzipKib: 3456.78 });
  });

  it("takes the LAST line when one deploy uploads several workers (os builder sidecar first)", () => {
    expect(
      parseWorkerSizeFromDeployOutput(
        [
          "Total Upload: 100.00 KiB / gzip: 30.00 KiB", // builder sidecar
          "some other output",
          "Total Upload: 91234.56 KiB / gzip: 3456.78 KiB", // the real worker
        ].join("\n"),
      ),
    ).toEqual({ totalKib: 91234.56, gzipKib: 3456.78 });
  });

  it("parses thousands separators", () => {
    expect(
      parseWorkerSizeFromDeployOutput("Total Upload: 1,234.56 KiB / gzip: 456.78 KiB"),
    ).toEqual({ totalKib: 1234.56, gzipKib: 456.78 });
  });

  it("returns null when no size line is present", () => {
    expect(parseWorkerSizeFromDeployOutput("wrangler deploy failed before upload")).toBeNull();
  });
});

describe("worker-size commit status description", () => {
  it("round-trips through format and parse", () => {
    const size = { totalKib: 91234.56, gzipKib: 3456.78 };
    expect(parseWorkerSizeStatusDescription(formatWorkerSizeStatusDescription(size))).toEqual(size);
  });

  it("stays within GitHub's 140-char description cap", () => {
    expect(
      formatWorkerSizeStatusDescription({ totalKib: 999999.99, gzipKib: 999999.99 }).length,
    ).toBeLessThan(140);
  });

  it("returns null for unrecognized descriptions", () => {
    expect(parseWorkerSizeStatusDescription("deploy ok")).toBeNull();
    expect(parseWorkerSizeStatusDescription(null)).toBeNull();
    expect(parseWorkerSizeStatusDescription(undefined)).toBeNull();
  });

  it("namespaces the status context by app slug", () => {
    expect(workerSizeStatusContext("os")).toBe("worker-size/os");
  });
});

describe("renderWorkerSizeCell", () => {
  it("is empty without a measured size", () => {
    expect(renderWorkerSizeCell(null, 3456.78)).toBe("");
    expect(renderWorkerSizeCell(undefined, null)).toBe("");
  });

  it("shows the absolute size when main has no baseline yet", () => {
    expect(renderWorkerSizeCell(3456.78, null)).toBe("3.38 MiB");
    expect(renderWorkerSizeCell(345.67, undefined)).toBe("345.7 KiB");
  });

  it("shows a signed delta against main's baseline", () => {
    expect(renderWorkerSizeCell(3506.78, 3456.78)).toBe("3.42 MiB (+50.0 KiB vs main)");
    expect(renderWorkerSizeCell(3406.78, 3456.78)).toBe("3.33 MiB (-50.0 KiB vs main)");
    expect(renderWorkerSizeCell(5504.78, 3456.78)).toBe("5.38 MiB (+2.00 MiB vs main)");
  });

  it("collapses sub-precision deltas to ±0", () => {
    expect(renderWorkerSizeCell(3456.78, 3456.78)).toBe("3.38 MiB (±0 vs main)");
  });
});

describe("formatKib", () => {
  it("formats KiB below 1 MiB and MiB above", () => {
    expect(formatKib(0)).toBe("0.0 KiB");
    expect(formatKib(345.67)).toBe("345.7 KiB");
    expect(formatKib(1024)).toBe("1.00 MiB");
    expect(formatKib(91234.56)).toBe("89.10 MiB");
  });
});
