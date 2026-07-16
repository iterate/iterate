export type EditorPathOverride = {
  source: string | undefined;
  target: string | undefined;
};

export type EditorPathDraft = {
  source: string;
  value: string;
  target?: string;
};

export function reconcileEditorPathOverride(
  override: EditorPathOverride | undefined,
  selectedPath: string | undefined,
) {
  return override !== undefined && override.source === selectedPath ? override : undefined;
}

export function editorPathDraftApplies(
  path: string | undefined,
  draft: EditorPathDraft | undefined,
) {
  return path !== undefined && (draft?.source === path || draft?.target === path);
}

export function editorPathValue(path: string | undefined, draft: EditorPathDraft | undefined) {
  if (path === undefined) return "";
  return draft !== undefined && editorPathDraftApplies(path, draft) ? draft.value : `/${path}`;
}

export function editorResolvedTaskPath(
  path: string | undefined,
  draft: EditorPathDraft | undefined,
) {
  return editorPathDraftApplies(path, draft) ? (draft?.target ?? path) : path;
}

export function resolvedEditorPathDraft(
  source: string,
  resolvedPath: string | undefined,
): EditorPathDraft | undefined {
  return resolvedPath === undefined || resolvedPath === source
    ? undefined
    : { source, target: resolvedPath, value: `/${resolvedPath}` };
}
