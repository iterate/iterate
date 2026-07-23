import { Streamdown } from "streamdown";
import { parseMarkdownFrontmatter } from "../tasks-model.ts";

/**
 * The Preview tab: the repo-IDE rendering — frontmatter as a metadata table,
 * body through streamdown (a settled document, so no incomplete-markdown
 * balancing). Lazy-loaded with the sheet's editor stack.
 */
export function WorkspaceTaskPreview({ source }: { source: string }) {
  const frontmatter = parseMarkdownFrontmatter(source);
  const record = (() => {
    try {
      const value: unknown = frontmatter.document.toJS();
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  })();
  const metadata = Object.entries(record).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-6 text-sm">
        {metadata.length === 0 ? null : (
          <div className="mb-6 overflow-hidden rounded-lg border bg-muted/20">
            <table className="w-full text-xs">
              <tbody>
                {metadata.map((property) => (
                  <tr key={property.key} className="border-b last:border-b-0">
                    <td className="w-36 px-3 py-1.5 font-medium text-muted-foreground">
                      {property.key}
                    </td>
                    <td className="px-3 py-1.5 font-mono whitespace-normal">{property.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Streamdown parseIncompleteMarkdown={false}>{frontmatter.body}</Streamdown>
      </div>
    </div>
  );
}
