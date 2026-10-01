import { EmptyPane, ErrorPane, FileChrome } from "./file-chrome.tsx";
import { RepoCodeEditor } from "./repo-code-editor.tsx";
import { repoFileKind } from "./repo-file-kinds.ts";
import { readRepoFile, useRead, type RepoProject } from "./repo-client.ts";

/**
 * Readonly diff of one file in one commit against that commit's first parent: what opens when a
 * changed file is clicked in the History view. The same readonly diff as the staged (Index) view:
 * lock icon, no chunk controls, no input.
 */
export function CommitDiffPane({
  project,
  repoPath,
  path,
  commit,
}: {
  project: RepoProject;
  repoPath: string;
  path: string;
  commit: { oid: string; parents: string[] };
}) {
  const kind = repoFileKind(path);
  const parentOid = commit.parents[0];
  const sides = useRead(async () => {
    if (kind.kind !== "text") return null;
    const [before, after] = await Promise.all([
      // the content before the commit: none for a root commit
      !parentOid ? undefined : readRepoFile(project, repoPath, path, parentOid),
      readRepoFile(project, repoPath, path, commit.oid),
    ]);
    return { before, after };
  }, [project, repoPath, path, commit.oid, parentOid, kind.kind]);

  const suffix = `(${commit.oid.slice(0, 7)})`;
  if (kind.kind !== "text") {
    return (
      <FileChrome path={path} suffix={suffix} readonly>
        <EmptyPane label="Binary file: the repo editor shows text files only." />
      </FileChrome>
    );
  }
  if (sides.status !== "loaded" || !sides.value) {
    return (
      <FileChrome path={path} suffix={suffix} readonly>
        {sides.status === "failed" ? (
          <ErrorPane message={sides.message} />
        ) : (
          <EmptyPane label={`Loading ${path}…`} spinner />
        )}
      </FileChrome>
    );
  }
  const { before, after } = sides.value;
  // undefined is a file not in that commit, "" an empty one
  // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty file is not a missing one
  if (before === undefined && after === undefined) {
    return (
      <FileChrome path={path} suffix={suffix} readonly>
        <EmptyPane label={`${path} is not in ${commit.oid.slice(0, 7)} or its parent.`} />
      </FileChrome>
    );
  }
  // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty file is not a missing one
  const status = before === undefined ? "added" : after === undefined ? "deleted" : "modified";
  return (
    <FileChrome path={path} suffix={suffix} readonly status={status}>
      <RepoCodeEditor
        key={`${path}:${commit.oid}`}
        className="min-h-0 flex-1"
        readOnly
        label={path}
        value={after || ""}
        language={kind.language}
        baseline={before || ""}
        diff
      />
    </FileChrome>
  );
}
