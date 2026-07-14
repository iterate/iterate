export type EditorPathOverride = {
  source: string | undefined;
  target: string | undefined;
};

export type EditorPathDraft = {
  source: string;
  value: string;
};

export function reconcileEditorPathOverride(
  override: EditorPathOverride | undefined,
  selectedPath: string | undefined,
) {
  return override !== undefined && override.source === selectedPath ? override : undefined;
}

export function editorPathValue(path: string | undefined, draft: EditorPathDraft | undefined) {
  if (path === undefined) return "";
  return draft?.source === path ? draft.value : `/${path}`;
}

export function resolvedEditorPathDraft(
  source: string,
  resolvedPath: string | undefined,
): EditorPathDraft | undefined {
  return resolvedPath === undefined || resolvedPath === source
    ? undefined
    : { source, value: `/${resolvedPath}` };
}
