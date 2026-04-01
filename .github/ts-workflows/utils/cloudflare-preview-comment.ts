import { markdownAnnotator } from "./github-script.ts";

export type PreviewCommentEntry = {
  appDisplayName: string;
  status:
    | "claim-failed"
    | "cleanup-failed"
    | "deploy-failed"
    | "deployed"
    | "fork-unavailable"
    | "released"
    | "tests-failed";
  leasedUntil?: number | null;
  message?: string | null;
  previewEnvironmentAlchemyStageName?: string | null;
  previewEnvironmentDopplerConfigName?: string | null;
  previewEnvironmentIdentifier?: string | null;
  previewEnvironmentSemaphoreLeaseId?: string | null;
  publicUrl?: string | null;
  runUrl?: string | null;
  shortSha?: string | null;
  updatedAt: string;
};

export type PreviewCommentState = Record<string, PreviewCommentEntry>;

export function readPreviewCommentState(args: {
  body: string;
  previewCommentMarker: string;
  previewCommentStateLabel: string;
}) {
  const previewStateAnnotator = markdownAnnotator(
    args.body || `${args.previewCommentMarker}\n## Preview Environments`,
    args.previewCommentStateLabel,
  );

  return {
    currentState: previewStateAnnotator.current
      ? (JSON.parse(previewStateAnnotator.current) as PreviewCommentState)
      : {},
  };
}

export function renderPreviewCommentBody(args: {
  previewCommentMarker: string;
  previewCommentStateLabel: string;
  state: PreviewCommentState;
}) {
  const rows = Object.values(args.state)
    .map((state) => {
      return [
        `### ${state.appDisplayName}`,
        "",
        `Status: ${previewStatusLabel(state.status)}`,
        state.previewEnvironmentIdentifier
          ? `Environment: \`${state.previewEnvironmentIdentifier}\``
          : null,
        state.previewEnvironmentDopplerConfigName
          ? `Config: \`${state.previewEnvironmentDopplerConfigName}\``
          : null,
        state.previewEnvironmentAlchemyStageName
          ? `Stage: \`${state.previewEnvironmentAlchemyStageName}\``
          : null,
        state.publicUrl ? `URL: ${state.publicUrl}` : null,
        state.leasedUntil
          ? `Leased until: ${new Date(Number(state.leasedUntil)).toISOString()}`
          : null,
        state.message ?? null,
        state.runUrl ? `[Workflow run](${state.runUrl})` : null,
        `Updated: ${state.updatedAt}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const body = markdownAnnotator(
    `${args.previewCommentMarker}\n## Preview Environments`,
    args.previewCommentStateLabel,
  ).update(JSON.stringify(args.state, null, 2));

  return rows ? `${body}\n\n${rows}` : body;
}

function previewStatusLabel(status: PreviewCommentEntry["status"]) {
  switch (status) {
    case "deployed":
      return "✅ deployed";
    case "tests-failed":
      return "❌ tests failed";
    case "deploy-failed":
      return "❌ deploy failed";
    case "claim-failed":
      return "❌ claim failed";
    case "released":
      return "🧹 released";
    case "cleanup-failed":
      return "❌ cleanup failed";
    case "fork-unavailable":
      return "⚪ unavailable";
  }
}
