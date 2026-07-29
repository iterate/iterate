import { useState } from "react";
import { parseAnnotatedMarkdown } from "iterate/annotated-markdown";
import type { StructuredDocument } from "iterate/annotated-markdown";

/** An edit against the parsed document; returns the next raw source. */
export type DiscussionOp = (doc: StructuredDocument) => { raw: string };

/**
 * The one lane every discussion mutation takes (comments strip AND the
 * preview's select-to-comment): re-parse at apply time so ops re-find their
 * targets by id, refuse to run while the editor is attaching (the raw-write
 * fallback would race the arriving session), and only report success once
 * the write actually LANDED — the write lane is optimistic and rolls back.
 */
export function useDiscussionApply({
  busy,
  onTransform,
}: {
  /** True while the file's live editor is still attaching. */
  busy: boolean;
  /** Route a whole-file transform to the live editor or the write lane;
   * resolves whether it landed (the write lane can roll back). */
  onTransform: (transform: (source: string) => string) => Promise<boolean>;
}) {
  const [opError, setOpError] = useState<string | null>(null);

  const apply = async (op: DiscussionOp): Promise<boolean> => {
    if (busy) {
      setOpError("Comment change failed: the editor is still connecting — retry in a moment");
      return false;
    }
    let ok = false;
    let failure = "the file changed mid-edit";
    const landed = await onTransform((current) => {
      const doc = parseAnnotatedMarkdown(current);
      if (doc.kind !== "structured") {
        failure = doc.diagnostics[0]?.message ?? "the file failed to parse";
        return current;
      }
      try {
        const result = op(doc);
        ok = true;
        return result.raw;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        return current;
      }
    });
    if (ok && !landed) failure = "the write did not reach the workspace — retry";
    ok = ok && landed;
    setOpError(ok ? null : `Comment change failed: ${failure}`);
    return ok;
  };

  return { apply, opError };
}
