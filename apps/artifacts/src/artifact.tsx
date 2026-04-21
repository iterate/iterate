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
  const { commits, tree } = useLoaderData({ from: "/$artifact" }) as {
    commits: { oid: string; message: string; author: string; timestamp: number }[];
    tree: string[];
  };
  const { artifact } = useParams({ from: "/$artifact" });
  const { commit: selectedCommit, file } = useSearch({ from: "/$artifact" }) as {
    commit?: string;
    file?: string;
  };
  const navigate = useNavigate();
  const router = useRouter();

  const isHead = !selectedCommit;

  const [head, setHead] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<Record<string, string>>({});
  const [fileContent, setFileContent] = useState<string | undefined>();
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [langExt, setLangExt] = useState<import("@codemirror/state").Extension[]>([]);

  const dirty = useMemo(
    () => new Set(Object.keys(working).filter((p) => working[p] !== head[p])),
    [working, head],
  );
  const hasLocalChanges = isHead && dirty.size > 0;
  const fileLoading = !!file && fileContent === undefined && !head[file!];

  useEffect(() => {
    setHead({});
    setWorking(jsonParse(localStorage.getItem(`art:${artifact}:working`), {}));
    setFileContent(undefined);
  }, [artifact]);

  useEffect(() => {
    if (isHead) localStorage.setItem(`art:${artifact}:working`, JSON.stringify(working));
  }, [artifact, working, isHead]);

  // Fetch file content — AbortController prevents stale responses from racing
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
      <div
        style={{ width: 200, borderRight: "1px solid #30363d", overflow: "auto", flexShrink: 0 }}
      >
        <h3 style={H3}>Files</h3>
        {tree.map((p) => (
          <div
            key={p}
            onClick={() => nav({ commit: selectedCommit, file: p })}
            style={{
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 13,
              background: p === file ? "#161b22" : "transparent",
              color: isHead && dirty.has(p) ? "#f0883e" : "#c9d1d9",
            }}
          >
            {isHead && dirty.has(p) ? "* " : ""}
            {p}
          </div>
        ))}
      </div>

      {/* Editor */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #30363d",
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {file && <span style={{ color: "#8b949e" }}>{file}</span>}
          {!isHead && (
            <span style={{ color: "#f0883e", fontSize: 12 }}>
              Viewing {selectedCommit!.slice(0, 7)} (read-only) — restore to make changes
            </span>
          )}
          {busy && <span style={{ color: "#f0883e", marginLeft: "auto" }}>{busy}</span>}
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {fileLoading ? (
            <div style={{ padding: 40, color: "#8b949e" }}>Loading file...</div>
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
            <div style={{ padding: 40, color: "#8b949e" }}>
              {file ? "File not found" : "Select a file"}
            </div>
          )}
        </div>
      </div>

      {/* History sidebar */}
      <div
        style={{
          width: 280,
          borderLeft: "1px solid #30363d",
          overflow: "auto",
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        <h3 style={H3}>History</h3>
        {hasLocalChanges && (
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #21262d" }}>
            <input
              style={{
                background: "#0d1117",
                color: "#c9d1d9",
                border: "1px solid #30363d",
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 13,
                width: "100%",
                marginBottom: 6,
              }}
              placeholder="Commit message"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCommit()}
            />
            <button
              style={{
                background: "#238636",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 13,
                width: "100%",
              }}
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
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid #21262d",
              background: "#161b22",
              borderLeft: "3px solid #f0883e",
            }}
          >
            <div style={{ color: "#f0883e", fontWeight: 600 }}>Local changes</div>
            <div style={{ color: "#8b949e", fontSize: 11 }}>
              {dirty.size} modified file{dirty.size !== 1 ? "s" : ""}
            </div>
          </div>
        )}
        {commits.map((c, i) => {
          const isLatest = i === 0;
          return (
            <div
              key={c.oid}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid #21262d",
                background:
                  selectedCommit === c.oid || (isHead && i === 0 && !hasLocalChanges)
                    ? "#161b22"
                    : "transparent",
              }}
            >
              <div
                onClick={() => nav({ commit: isLatest ? undefined : c.oid, file })}
                style={{ cursor: "pointer" }}
              >
                <div
                  style={{
                    color: "#c9d1d9",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {isLatest && "HEAD — "}
                  {c.message.split("\n")[0]}
                </div>
                <div style={{ color: "#8b949e", fontSize: 11, marginTop: 2 }}>
                  {c.oid.slice(0, 7)} &middot; {c.author} &middot;{" "}
                  {new Date(c.timestamp * 1000).toLocaleDateString()}
                </div>
              </div>
              {!isLatest && selectedCommit === c.oid && (
                <button
                  style={{
                    background: "transparent",
                    color: "#58a6ff",
                    border: "1px solid #30363d",
                    borderRadius: 4,
                    padding: "2px 8px",
                    cursor: "pointer",
                    fontSize: 12,
                    marginTop: 4,
                  }}
                  onClick={() => handleRestore(c.oid)}
                >
                  Restore to this commit
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function jsonParse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const H3 = {
  padding: "8px 12px",
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: 1,
  color: "#8b949e",
};
