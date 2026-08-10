// The 🐛 drawer item's whole flow: snapshot the session log, durably append a
// bug-report-filed event (so an agent can fetch full context later no matter
// what), put a paste-ready markdown block on the clipboard, then send Misha
// to the PR/commit page for this exact bundle to add a screenshot + a
// sentence. Zero GitHub credentials involved — GitHub has no URL param that
// prefills a PR comment, so clipboard-paste IS the prefill.
import * as Clipboard from "expo-clipboard";
import * as Updates from "expo-updates";
import { Alert, Linking } from "react-native";
import { buildInfo } from "./build-info.ts";
import { buildBugReportMarkdown } from "./bug-report-markdown.ts";
import { getProjectItx } from "./itx.ts";
import { getPreviewChannelOverride } from "./preview-channel.ts";
import { DEFAULT_SERVER } from "./servers.ts";
import { getSessionLog, SESSION_STREAM_PATH } from "./session-log.ts";
import { getServerBaseUrl } from "./storage.ts";

/** The report must feel instant: past this, give up on the durable append
 * and ship a clipboard block without the event reference. */
const APPEND_TIMEOUT_MS = 2000;

export async function reportBug(project: { projectId: string; projectSlug: string } | null) {
  const entries = getSessionLog();
  const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
  const channelOverride = await getPreviewChannelOverride().catch(() => null);
  const updates = {
    channel: Updates.channel,
    channelOverride,
    runtimeVersion: Updates.runtimeVersion,
    updateId: Updates.updateId,
  };

  // Outside a project (the app-level drawer) there is no stream to append
  // to — the clipboard trail is the whole report.
  const reportEventOffset =
    project === null
      ? null
      : await Promise.race([
          appendReportEvent({ baseUrl, projectId: project.projectId, updates, entries }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), APPEND_TIMEOUT_MS)),
        ]).catch(() => null);

  const markdown = buildBugReportMarkdown({
    build: buildInfo,
    updates,
    server: { baseUrl, project },
    reportEventOffset,
    entries,
  });
  await Clipboard.setStringAsync(markdown);

  Alert.alert(
    "Session context copied",
    "Paste it into a comment, add a screenshot, and say what went wrong.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Open GitHub", onPress: () => void Linking.openURL(buildInfo.githubUrl) },
    ],
  );
}

async function appendReportEvent(args: {
  baseUrl: string;
  projectId: string;
  updates: Record<string, string | null>;
  entries: ReturnType<typeof getSessionLog>;
}): Promise<number | null> {
  const project = await getProjectItx(args.baseUrl, args.projectId);
  const appended = await project.streams.get(SESSION_STREAM_PATH).append({
    type: "events.iterate.com/mobile/bug-report-filed",
    payload: {
      at: new Date().toISOString(),
      build: buildInfo,
      updates: args.updates,
      baseUrl: args.baseUrl,
      projectId: args.projectId,
      sessionLog: args.entries,
    },
  });
  return appended[0]?.offset ?? null;
}
