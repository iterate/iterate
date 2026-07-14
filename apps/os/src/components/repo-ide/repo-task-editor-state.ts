export type EditorPathOverride = {
  source: string | undefined;
  target: string | undefined;
};

export function reconcileEditorPathOverride(
  override: EditorPathOverride | undefined,
  selectedPath: string | undefined,
) {
  return override !== undefined && override.source === selectedPath ? override : undefined;
}
