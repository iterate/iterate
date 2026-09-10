import type { FeedLiveState } from "~/domains/streams/feed-contract.ts";

/** Expected size limits remain visible without turning a connected feed into a loading state. */
export function FeedPreviewNotice({
  status,
}: {
  status: FeedLiveState["previewStatus"] | undefined;
}) {
  if (!status || status === "available") return null;
  return (
    <p className="px-4 py-2 text-sm text-muted-foreground" role="status">
      {status === "omitted"
        ? "Live preview is too large to display. Recorded activity remains available in stream history."
        : "Live preview shortened. Completed responses appear in full in their traces."}
    </p>
  );
}
