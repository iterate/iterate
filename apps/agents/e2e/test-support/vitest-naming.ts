import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { slugify } from "@iterate-com/shared/slugify";

export const VITEST_RUN_SLUG_KEY = "VITEST_RUN_SLUG";

export function createVitestRunSlug(now: Date = new Date()) {
  return slugify(`vitest-run-${formatDateTime(now)}`);
}

export function createTestExecutionSuffix(now: Date = new Date()) {
  return `${formatDateTime(now)}-${randomBytes(3).toString("hex")}`;
}

export function createEventsStreamPath(args: {
  repoRoot: string;
  testFilePath: string;
  testFullName: string;
  executionSuffix: string;
}) {
  const relativeFilePath = relative(args.repoRoot, args.testFilePath).replaceAll("\\", "/");
  const strippedFullName = stripFilePrefix({
    relativeFilePath,
    testFullName: args.testFullName,
  });
  const hierarchy = strippedFullName.split(" > ").filter(Boolean);
  const fileSegments = relativeFilePath
    .split("/")
    .filter(Boolean)
    .map((segment) => slugify(segment));
  const hierarchySegments = hierarchy.map((segment) => slugify(segment));
  const executionSegment = slugify(args.executionSuffix);

  return `/${[...fileSegments, ...hierarchySegments, executionSegment].join("/")}`;
}

function stripFilePrefix(args: { relativeFilePath: string; testFullName: string }) {
  const prefix = `${args.relativeFilePath} > `;
  if (args.testFullName.startsWith(prefix)) {
    return args.testFullName.slice(prefix.length);
  }

  return args.testFullName;
}

function formatDateTime(date: Date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}
