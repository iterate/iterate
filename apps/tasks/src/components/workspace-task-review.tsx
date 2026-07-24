import "@plannotator/ui/styles.css";
import { useMemo } from "react";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { exportAnnotations, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { annotateFileFeedback } from "@plannotator/core/feedback-templates";
import type { Annotation } from "@plannotator/ui/types";
import { useWorkspaceAnnotations } from "../lib/workspace-annotations-client.ts";

export function WorkspaceTaskReview({
  checkoutId,
  repoPath,
  path,
  markdown,
  selectedAnnotationId,
  onSelectAnnotation,
}: {
  checkoutId: string;
  repoPath: string;
  path: string;
  markdown: string;
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
}) {
  const review = useWorkspaceAnnotations(checkoutId, repoPath, path);
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);

  const remove = (id: string) => {
    if (selectedAnnotationId === id) onSelectAnnotation(null);
    void review.remove(id);
  };

  return (
    <ThemeProvider defaultTheme="light" defaultColorTheme="plannotator">
      <div className="flex min-h-0 flex-1 bg-background">
        <div className="min-w-0 flex-1 overflow-auto bg-muted/20 p-4">
          <p className="mb-2 text-right font-mono text-[11px] text-muted-foreground">
            {review.status === "live"
              ? `${review.annotations.length} annotations · live`
              : "connecting review…"}
          </p>
          {review.error === null ? null : (
            <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-red-700">
              review sync failed: {review.error}
            </p>
          )}
          <Viewer
            markdown={markdown}
            blocks={blocks}
            annotations={review.annotations}
            onAddAnnotation={(annotation) => void review.add(annotation)}
            onSelectAnnotation={onSelectAnnotation}
            selectedAnnotationId={selectedAnnotationId}
            mode="selection"
            taterMode={false}
            disableCodePathValidation={true}
            allowImages={false}
            gridEnabled={true}
            maxWidth={900}
            copyLabel="Copy task"
          />
        </div>
        <AnnotationPanel
          isOpen={true}
          annotations={review.annotations}
          blocks={blocks}
          onSelect={(id) => onSelectAnnotation(id)}
          onDelete={remove}
          onEdit={(id, updates: Partial<Annotation>) => void review.update(id, updates)}
          selectedId={selectedAnnotationId}
          sharingEnabled={true}
          width={300}
          onQuickCopy={async () => {
            const feedback = exportAnnotations(blocks, review.annotations, [], "Task review", "task");
            await navigator.clipboard.writeText(annotateFileFeedback(feedback, { filePath: path }));
          }}
        />
      </div>
    </ThemeProvider>
  );
}
