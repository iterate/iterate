/** One explanation for shortened responses in the live feed, rounds, and request inspector. */
export function LlmPreviewNotice({ truncated }: { truncated: boolean | undefined }) {
  if (!truncated) return null;
  return (
    <p className="px-1.5 py-1 text-xs text-muted-foreground">
      Live preview shortened. Completed responses appear in full in their traces.
    </p>
  );
}
