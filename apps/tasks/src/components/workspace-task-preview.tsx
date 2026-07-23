import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Table, TableBody, TableCell, TableRow } from "@iterate-com/ui/components/table";
import { projectMarkdownPreview } from "~/components/repo-ide/markdown-frontmatter.ts";

/**
 * The Preview tab: the SAME rendering path as the apps/os repo IDE —
 * projectMarkdownPreview for the frontmatter table, MessageResponse
 * (streamdown, GitHub-sanitized by its default rehype pipeline) for the
 * body. Local and instant; no server round trip. SECURITY INVARIANT (from
 * the os pane): don't pass `rehypePlugins` without re-checking sanitization.
 */
export function WorkspaceTaskPreview({ source }: { source: string }) {
  const preview = projectMarkdownPreview(source);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-6 text-sm">
        {preview.metadata.length === 0 ? null : (
          <div className="mb-6 overflow-hidden rounded-lg border bg-muted/20">
            <Table className="text-xs">
              <TableBody>
                {preview.metadata.map((property) => (
                  <TableRow key={property.key} className="hover:bg-transparent">
                    <TableCell className="w-36 py-1.5 font-medium text-muted-foreground">
                      {property.key}
                    </TableCell>
                    <TableCell className="py-1.5 font-mono whitespace-normal">
                      {property.value}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {/* A settled document, not a stream — skip streamdown's unpaired-
            marker balancing (it appends a phantom `*` to text like "17 * 23"). */}
        <MessageResponse
          loadingFallback={
            <div className="text-sm text-muted-foreground" data-spinner="true" role="status">
              Rendering preview...
            </div>
          }
          parseIncompleteMarkdown={false}
        >
          {preview.body}
        </MessageResponse>
      </div>
    </div>
  );
}
