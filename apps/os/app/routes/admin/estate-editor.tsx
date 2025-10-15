import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { vsCodeDark, vsCodeLight } from "@fsegurai/codemirror-theme-bundle";
import { useTheme } from "next-themes";
import { File, Folder } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import { useTRPC } from "../../lib/trpc.ts";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: "typescript" | "markdown";
}

function CodeEditor({ value, onChange, language }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    viewRef.current?.destroy();

    const lang = language === "typescript" ? javascript({ typescript: true }) : markdown();
    const codeMirrorTheme = resolvedTheme === "dark" ? vsCodeDark : vsCodeLight;

    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        codeMirrorTheme,
        lang,
        search({ top: true }),
        keymap.of(searchKeymap),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),
        EditorView.contentAttributes.of({ tabindex: "0" }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value and onChange excluded to avoid recreating editor on every change
  }, [language, resolvedTheme]);

  // Update document when value changes externally
  useEffect(() => {
    if (viewRef.current && viewRef.current.state.doc.toString() !== value) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full" />;
}

interface IDEProps {
  repositoryNameWithOwner: string;
  refName: string;
}

function IDE({ repositoryNameWithOwner, refName }: IDEProps) {
  const trpc = useTRPC();
  const [bump, setBump] = useState(0);
  const getRepoFilesystemQueryOptions = trpc.estate.getRepoFilesystem.queryOptions({
    repositoryNameWithOwner,
    refName,
    ...({ bump } as {}),
  });
  const getRepoFileSystemQuery = useQuery({
    ...getRepoFilesystemQueryOptions,
    placeholderData: (old) => old,
  });

  const saveFileMutation = useMutation(
    trpc.estate.updateRepo.mutationOptions({
      onSuccess: () => setBump((prev) => prev + 1),
    }),
  );

  const { filesystem, sha } = getRepoFileSystemQuery.data || { filesystem: {}, sha: "" };
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>(filesystem);

  // Update file contents when filesystem prop changes
  useEffect(() => {
    setFileContents(filesystem);
    // If current file doesn't exist in new filesystem, reset selection
    if (selectedFile && !(selectedFile in filesystem)) {
      setSelectedFile(null);
    }
  }, [filesystem, selectedFile]);

  const files = Object.keys(fileContents).sort();
  const currentContent = selectedFile ? fileContents[selectedFile] : "";

  // Check if a file has been edited
  const isFileEdited = (filename: string): boolean => {
    return fileContents[filename] !== filesystem[filename];
  };

  // Check if current file has unsaved changes
  const hasUnsavedChanges = selectedFile ? isFileEdited(selectedFile) : false;

  const handleContentChange = (newContent: string) => {
    if (selectedFile) {
      setFileContents((prev) => ({
        ...prev,
        [selectedFile]: newContent,
      }));
    }
  };

  const handleSave = () => {
    if (selectedFile) {
      saveFileMutation.mutate({
        branch: {
          repositoryNameWithOwner,
          branchName: refName,
        },
        expectedHeadOid: sha,
        message: { headline: `in-browser changes to ${selectedFile}` },
        fileChanges: {
          additions: [{ path: selectedFile, contents: btoa(fileContents[selectedFile]) }],
        },
      });
    }
  };

  const getLanguage = (filename: string): "typescript" | "markdown" => {
    if (filename.endsWith(".md")) return "markdown";
    return "typescript";
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] border rounded-lg overflow-hidden">
      {/* Left sidebar - File list */}
      <div className="w-64 flex-shrink-0 border-r bg-muted/50 overflow-y-auto">
        <div className="p-4">
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Folder className="h-4 w-4" />
            Files
          </h3>
          <div className="space-y-1">
            {files.map((filename) => (
              <button
                key={filename}
                onClick={() => setSelectedFile(filename)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2 hover:bg-accent",
                  selectedFile === filename && "bg-accent",
                )}
              >
                <File className="h-4 w-4" />
                <span>
                  {filename}
                  {isFileEdited(filename) && <span className="text-orange-500">*</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main panel - Editor */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selectedFile ? (
          <>
            <div className="border-b p-3 flex items-center justify-between bg-background">
              <span className="text-sm font-medium">
                {selectedFile}
                {hasUnsavedChanges && <span className="text-orange-500">*</span>}
              </span>
              <Button
                onClick={handleSave}
                disabled={
                  !hasUnsavedChanges ||
                  saveFileMutation.isPending ||
                  getRepoFileSystemQuery.isPending
                }
                size="sm"
              >
                {saveFileMutation.isPending || getRepoFileSystemQuery.isPending
                  ? "Saving..."
                  : "Save"}
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              <CodeEditor
                value={currentContent}
                onChange={handleContentChange}
                language={getLanguage(selectedFile)}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a file to edit
          </div>
        )}
      </div>
    </div>
  );
}

export default function EstateEditor() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Estate Editor</h1>
        <p className="text-muted-foreground">
          Edit estate configuration files. Changes will be saved to GitHub.
        </p>
      </div>
      <IDE repositoryNameWithOwner={"iterate-estates/mktest1"} refName={"main"} />
    </div>
  );
}
