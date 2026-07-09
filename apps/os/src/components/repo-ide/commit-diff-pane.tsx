import { useMemo } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { repoFileKind } from "./repo-file-kinds.ts";
import { EmptyPane, FileChrome } from "./repo-editor-pane.tsx";
import { useItxQuery } from "~/itx/itx-react.tsx";

/**
 * Readonly diff of one file in one commit against that commit's first parent
 * — what opens when a changed file is clicked in the History view. Same
 * readonly `unifiedMergeView` treatment as the staged (Index) view: lock
 * icon, no chunk controls, editor rejects input. Both sides are pinned
 * `readFile({ commitOid })` reads, so this pane is pure composition over the
 * existing content lanes. Suspends; mount under the IDE's Suspense boundary.
 */
export function CommitDiffPane({
  projectId,
  repoPath,
  path,
  commitOid,
}: {
  projectId: string;
  repoPath: string;
  path: string;
  commitOid: string;
}) {
  const kind = repoFileKind(path);
  // Same key as the expanded history row — a commit's details are immutable,
  // so this is a cache hit whenever the row that opened this pane is showing.
  const details = useItxQuery({
    key: ["repo-commit", projectId, repoPath, commitOid],
    query: (itx) => itx.repos.get(repoPath).commitDetails({ commitOid }),
  });
  const parentOid = details.parentOid;
  const file = details.files.find((candidate) => candidate.path === path);

  const sides = useItxQuery({
    key: ["repo-commit-file", projectId, repoPath, commitOid, path],
    query: async (itx) => {
      if (kind.kind !== "text" || file === undefined) return null;
      const repo = itx.repos.get(repoPath);
      const [before, after] = await Promise.all([
        // Content BEFORE the commit: absent for added files and root commits.
        parentOid === null || file.status === "added"
          ? null
          : repo.readFile({ path, commitOid: parentOid }),
        // Content AT the commit: absent for deleted files.
        file.status === "deleted" ? null : repo.readFile({ path, commitOid }),
      ]);
      return { after: after?.content || "", before: before?.content || "" };
    },
  });

  const diffExtensions = useMemo(
    () =>
      sides === null
        ? []
        : [
            unifiedMergeView({
              original: sides.before,
              allowInlineDiffs: true,
              mergeControls: false,
            }),
          ],
    [sides],
  );

  const suffix = `(${commitOid.slice(0, 7)})`;
  if (file === undefined) {
    return (
      <FileChrome path={path} suffix={suffix} readonly>
        <EmptyPane label={`This file did not change in ${commitOid.slice(0, 7)}.`} />
      </FileChrome>
    );
  }

  if (kind.kind !== "text" || file.binary || sides === null) {
    return (
      <FileChrome path={path} suffix={suffix} readonly status={file.status}>
        <EmptyPane label={`Binary file ${file.status} in ${commitOid.slice(0, 7)}.`} />
      </FileChrome>
    );
  }

  return (
    <FileChrome path={path} suffix={suffix} readonly status={file.status}>
      <SourceCodeBlock
        key={`${path}:${commitOid}`}
        className="min-h-0 flex-1"
        plainChrome
        showLineNumbers
        editable={false}
        wrapLongLines={false}
        code={sides.after}
        language={kind.language}
        codeMirrorExtensions={diffExtensions}
        onChange={() => {}}
      />
    </FileChrome>
  );
}
