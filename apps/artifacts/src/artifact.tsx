/** Artifact view — file tree, editor with syntax highlighting, commit history, restore. */
import {
  useLoaderData,
  useParams,
  useSearch,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export function ArtifactView() {
  const { commits, tree } = useLoaderData({ from: "/$artifact" });
  const { artifact } = useParams({ from: "/$artifact" });
  const { commit: selectedCommit, file } = useSearch({ from: "/$artifact" });
  const navigate = useNavigate();
  const router = useRouter();

  const isHead = !selectedCommit;

  const [head, setHead] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<Record<string, string>>({});
  const [fileContent, setFileContent] = useState<string | undefined>();
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [langExt, setLangExt] = useState<import("@codemirror/state").Extension[]>([]);

  const treeNodes = useMemo(() => buildTree(tree), [tree]);
  // Auto-expand folders containing the selected file
  const [expanded, setExpanded] = useState<Set<string>>(() => expandToFile(file));
  useEffect(() => {
    if (file) setExpanded((prev) => new Set([...prev, ...expandToFile(file)]));
  }, [file]);
  const dirty = useMemo(
    () => new Set(Object.keys(working).filter((p) => working[p] !== head[p])),
    [working, head],
  );
  const hasLocalChanges = isHead && dirty.size > 0;
  const fileLoading = !!file && fileContent === undefined && !head[file!];

  useEffect(() => {
    setHead({});
    setWorking(JSON.parse(localStorage.getItem(`art:${artifact}:working`) || "{}"));
    setFileContent(undefined);
  }, [artifact]);

  useEffect(() => {
    if (isHead) localStorage.setItem(`art:${artifact}:working`, JSON.stringify(working));
  }, [artifact, working, isHead]);

  // AbortController prevents stale responses from racing on quick file switches
  useEffect(() => {
    setFileContent(undefined);
    if (!file) return;
    const controller = new AbortController();
    const qs = selectedCommit ? `&oid=${selectedCommit}` : "";
    fetch(`/api/blob?repo=${artifact}&path=${encodeURIComponent(file)}${qs}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        setFileContent(d.content);
        if (isHead) {
          setHead((h) => ({ ...h, [file]: d.content }));
          setWorking((w) => ({ ...w, [file]: w[file] ?? d.content }));
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
    return () => controller.abort();
  }, [artifact, file, selectedCommit, isHead]);

  // https://codemirror.net/docs/ref/#language-data
  useEffect(() => {
    if (!file) return setLangExt([]);
    const desc = LanguageDescription.matchFilename(languages, file);
    if (!desc) return setLangExt([]);
    desc.load().then((lang) => setLangExt([lang]));
  }, [file]);

  const extensions = useMemo(() => {
    const exts = [...langExt];
    if (!isHead) exts.push(EditorView.editable.of(false));
    return exts;
  }, [isHead, langExt]);

  const editorValue = isHead && file && working[file] !== undefined ? working[file] : fileContent;

  function nav(search: { commit?: string; file?: string }) {
    navigate({ to: "/$artifact", params: { artifact }, search });
  }

  // https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#using-routerinvalidate
  async function handleCommit() {
    if (dirty.size === 0 || !commitMsg.trim()) return;
    setBusy("Committing...");
    await fetch("/api/commit", {
      method: "POST",
      body: JSON.stringify({
        repo: artifact,
        message: commitMsg,
        files: [...dirty].map((p) => ({ path: p, content: working[p] })),
      }),
      headers: { "content-type": "application/json" },
    });
    localStorage.removeItem(`art:${artifact}:working`);
    setCommitMsg("");
    setWorking({});
    setHead({});
    setBusy("");
    await router.invalidate();
  }

  async function handleRestore(oid: string) {
    setBusy("Restoring...");
    await fetch("/api/restore", {
      method: "POST",
      body: JSON.stringify({ repo: artifact, oid }),
      headers: { "content-type": "application/json" },
    });
    localStorage.removeItem(`art:${artifact}:working`);
    setWorking({});
    setHead({});
    setBusy("");
    await router.invalidate();
  }

  return (
    <>
      {/* File tree */}
      <div className="w-[220px] border-r border-[#30363d] overflow-auto shrink-0">
        <h3 className="px-3 py-2 text-[11px] uppercase tracking-wide text-[#8b949e]">Files</h3>
        <FileTree
          nodes={treeNodes}
          depth={0}
          selected={file}
          dirty={isHead ? dirty : undefined}
          expanded={expanded}
          onSelect={(path) => nav({ commit: selectedCommit, file: path })}
          onToggle={(path) =>
            setExpanded((prev) => {
              const next = new Set(prev);
              next.has(path) ? next.delete(path) : next.add(path);
              return next;
            })
          }
        />
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="px-3 py-2 border-b border-[#30363d] flex gap-2 items-center text-[13px] shrink-0">
          {file && <span className="text-[#8b949e]">{file}</span>}
          {!isHead && (
            <span className="text-orange-400 text-xs">
              Viewing {selectedCommit!.slice(0, 7)} (read-only) — restore to make changes
            </span>
          )}
          {busy && <span className="text-orange-400 ml-auto">{busy}</span>}
        </div>
        <div className="flex-1 overflow-auto">
          {fileLoading ? (
            <div className="p-10 text-[#8b949e]">Loading file...</div>
          ) : file && editorValue !== undefined ? (
            <CodeMirror
              key={file}
              value={editorValue}
              height="100%"
              theme="dark"
              extensions={extensions}
              readOnly={!isHead}
              onChange={isHead ? (val) => setWorking((w) => ({ ...w, [file]: val })) : undefined}
            />
          ) : (
            <div className="p-10 text-[#8b949e]">{file ? "File not found" : "Select a file"}</div>
          )}
        </div>
      </div>

      {/* History sidebar */}
      <div className="w-[280px] border-l border-[#30363d] overflow-auto text-[13px] shrink-0">
        <h3 className="px-3 py-2 text-[11px] uppercase tracking-wide text-[#8b949e]">History</h3>
        {hasLocalChanges && (
          <div className="px-3 py-2 border-b border-[#21262d]">
            <input
              className="w-full bg-[#0d1117] text-[#c9d1d9] border border-[#30363d] rounded px-2 py-1 text-[13px] mb-1.5 outline-none focus:border-blue-500"
              placeholder="Commit message"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCommit()}
            />
            <button
              className="w-full bg-green-700 hover:bg-green-600 text-white border-none rounded-md py-1.5 px-3 cursor-pointer text-[13px] disabled:opacity-50"
              onClick={handleCommit}
              disabled={!commitMsg.trim()}
            >
              Commit &amp; push {dirty.size} file{dirty.size !== 1 ? "s" : ""}
            </button>
          </div>
        )}
        {hasLocalChanges && (
          <div
            onClick={() => nav({ file })}
            className="px-3 py-2 border-b border-[#21262d] bg-[#161b22] border-l-[3px] border-l-orange-400 cursor-pointer"
          >
            <div className="text-orange-400 font-semibold">Local changes</div>
            <div className="text-[#8b949e] text-[11px]">
              {dirty.size} modified file{dirty.size !== 1 ? "s" : ""}
            </div>
          </div>
        )}
        {commits.map(
          (c: { oid: string; message: string; author: string; timestamp: number }, i: number) => {
            const isLatest = i === 0;
            const isActive = selectedCommit === c.oid || (isHead && i === 0 && !hasLocalChanges);
            return (
              <div
                key={c.oid}
                className={`px-3 py-2 border-b border-[#21262d] ${isActive ? "bg-[#161b22]" : ""}`}
              >
                <div
                  onClick={() => nav({ commit: isLatest ? undefined : c.oid, file })}
                  className="cursor-pointer"
                >
                  <div className="text-[#c9d1d9] truncate">
                    {isLatest && "HEAD — "}
                    {c.message.split("\n")[0]}
                  </div>
                  <div className="text-[#8b949e] text-[11px] mt-0.5">
                    {c.oid.slice(0, 7)} &middot; {c.author} &middot;{" "}
                    {new Date(c.timestamp * 1000).toLocaleDateString()}
                  </div>
                </div>
                {!isLatest && selectedCommit === c.oid && (
                  <button
                    className="mt-1 bg-transparent text-blue-400 border border-[#30363d] rounded px-2 py-0.5 cursor-pointer text-xs hover:bg-[#161b22]"
                    onClick={() => handleRestore(c.oid)}
                  >
                    Restore to this commit
                  </button>
                )}
              </div>
            );
          },
        )}
      </div>
    </>
  );
}

// --- File tree ---

type TreeNode = { name: string; path: string; children: TreeNode[] };

function buildTree(paths: string[]) {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const path of paths.sort()) {
    const parts = path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const partial = parts.slice(0, i + 1).join("/");
      let child = current.children.find((c) => c.path === partial);
      if (!child) {
        child = { name: parts[i], path: partial, children: [] };
        current.children.push(child);
      }
      current = child;
    }
  }
  return root.children;
}

function FileTree({
  nodes,
  depth,
  selected,
  dirty,
  expanded,
  onSelect,
  onToggle,
}: {
  nodes: TreeNode[];
  depth: number;
  selected?: string;
  dirty?: Set<string>;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isFolder = node.children.length > 0;
        const isOpen = expanded.has(node.path);
        const isDirty = dirty?.has(node.path);
        return (
          <div key={node.path}>
            <div
              onClick={() => (isFolder ? onToggle(node.path) : onSelect(node.path))}
              className={`flex items-center gap-1 py-0.5 cursor-pointer text-[13px] hover:bg-[#161b22] ${node.path === selected ? "bg-[#161b22]" : ""} ${isDirty ? "text-orange-400" : "text-[#c9d1d9]"}`}
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              <span className="w-3 text-[10px] text-center shrink-0 text-[#8b949e]">
                {isFolder ? (isOpen ? "▾" : "▸") : ""}
              </span>
              <span className="shrink-0 text-[12px]">
                {isFolder ? (isOpen ? "📂" : "📁") : fileIcon(node.name)}
              </span>
              <span className="truncate">
                {isDirty ? "* " : ""}
                {node.name}
              </span>
            </div>
            {isFolder && isOpen && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                selected={selected}
                dirty={dirty}
                expanded={expanded}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "js" || ext === "ts" || ext === "tsx" || ext === "jsx") return "📜";
  if (ext === "json") return "📋";
  if (ext === "html" || ext === "htm") return "🌐";
  if (ext === "css") return "🎨";
  if (ext === "md") return "📝";
  return "📄";
}

/** Returns the set of parent folder paths that need to be expanded to reveal a file. */
function expandToFile(file?: string) {
  if (!file) return new Set<string>();
  const parts = file.split("/");
  const paths = new Set<string>();
  for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  return paths;
}
