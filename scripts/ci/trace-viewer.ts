import { readFile } from "node:fs/promises";
import type { Trace } from "./trace-model.ts";

export async function renderTrace(trace: Trace) {
  const template = await readFile(new URL("./trace-viewer.html", import.meta.url), "utf8");
  // Escaping '<' prevents test names containing </script> from executing as HTML.
  return template.replace("__TRACE_DATA__", JSON.stringify(trace).replaceAll("<", "\\u003c"));
}
