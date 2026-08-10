// Streams session-log entries to the open project's /mobile-events stream:
// `ephemeral: true` for the routine trail (memory-only on the server — live
// watchers can follow along, durable storage doesn't bloat), a durable
// append for errors. Fire-and-forget by contract. Split from session-log.ts
// so that module stays import-free (auth.ts etc. log without cycles);
// installed once from _layout.tsx module scope.
import { getProjectItx } from "./itx.ts";
import { DEFAULT_SERVER } from "./servers.ts";
import { getSessionProject, SESSION_STREAM_PATH, setSessionLogListener } from "./session-log.ts";
import type { SessionLogEntry } from "./session-log.ts";
import { getServerBaseUrl } from "./storage.ts";

export function installSessionLogMirror() {
  setSessionLogListener((entry, options) => mirror(entry, options));
}

function mirror(entry: SessionLogEntry, options: { durable: boolean }) {
  const projectId = getSessionProject();
  if (!projectId) return;
  void (async () => {
    const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
    const project = await getProjectItx(baseUrl, projectId);
    await project.streams.get(SESSION_STREAM_PATH).append({
      type: entry.type,
      payload: { ...entry.payload, at: entry.at },
      ...(options.durable ? {} : { ephemeral: true as const }),
    });
  })().catch(() => {
    // Swallowed on purpose: routing mirror failures back into logError would
    // loop, and the ring buffer already has the entry for the next report.
  });
}
