import { z } from "zod";

/** Small immutable blocks keep both structural diffs and React updates local.
 * The two levels copy at most one 32-block group plus the group index on append.
 * Blocks may contain one extra UTF-16 unit to keep a surrogate pair together. */
export const textBlockSize = 1024;
export const textGroupSize = 32;

const textIndex = z.string().regex(/^(0|[1-9]\d*)$/);
export const ChunkedText = z
  .strictObject({
    length: z.number().int().nonnegative(),
    blockCount: z.number().int().nonnegative(),
    /** Start of the latest append within the last block; only this tail animates. */
    tailOffset: z.number().int().nonnegative(),
    groups: z.record(textIndex, z.record(textIndex, z.string().max(textBlockSize + 1))),
  })
  .superRefine((text, ctx) => {
    let length = 0;
    let count = 0;
    for (const group of Object.values(text.groups)) count += Object.keys(group).length;
    if (count !== text.blockCount) {
      ctx.addIssue({ code: "custom", message: "Text block count does not match its content" });
      return;
    }
    for (let index = 0; index < text.blockCount; index++) {
      const block = text.groups[Math.floor(index / textGroupSize)]?.[index];
      if (block === undefined || (index < text.blockCount - 1 && block.length < textBlockSize)) {
        ctx.addIssue({
          code: "custom",
          message: "Text blocks must be contiguous and full before the tail",
        });
        return;
      }
      length += block.length;
    }
    const last =
      text.groups[Math.floor((text.blockCount - 1) / textGroupSize)]?.[text.blockCount - 1];
    if (length !== text.length || text.tailOffset > (last?.length ?? 0)) {
      ctx.addIssue({ code: "custom", message: "Text block metadata does not match its content" });
    }
  });

export type ChunkedText = z.infer<typeof ChunkedText>;
/** Recorded text stays a string; an in-progress append stream uses immutable blocks. */
export const StreamText = z.union([z.string(), ChunkedText]);
export type StreamText = z.infer<typeof StreamText>;

export function appendText(text: StreamText, suffix: string): ChunkedText {
  const previous: ChunkedText =
    typeof text === "string" ? { length: 0, blockCount: 0, tailOffset: 0, groups: {} } : text;
  const addition = typeof text === "string" ? text + suffix : suffix;
  if (addition === "") return previous;
  const groups = { ...previous.groups };
  let { length, blockCount, tailOffset } = previous;
  let offset = 0;
  while (offset < addition.length) {
    let index = Math.max(0, blockCount - 1);
    let groupIndex = Math.floor(index / textGroupSize);
    let block = groups[groupIndex]?.[index] ?? "";
    // A provider can split a surrogate pair between chunks. Complete that pair
    // in the existing block even when it just reached its normal capacity.
    const completesPair =
      /[\uD800-\uDBFF]$/.test(block) && /[\uDC00-\uDFFF]/.test(addition[offset]!);
    if (block.length >= textBlockSize && !completesPair) {
      index = blockCount;
      groupIndex = Math.floor(index / textGroupSize);
      block = "";
    }
    let end = Math.min(addition.length, offset + Math.max(1, textBlockSize - block.length));
    if (/[\uD800-\uDBFF]/.test(addition[end - 1]!) && /[\uDC00-\uDFFF]/.test(addition[end] ?? ""))
      end += 1;
    tailOffset = block.length;
    groups[groupIndex] = { ...groups[groupIndex], [index]: block + addition.slice(offset, end) };
    length += end - offset;
    blockCount = index + 1;
    offset = end;
  }
  return { length, blockCount, tailOffset, groups };
}

/** Materialize only the requested characters, e.g. a code prefix or a TUI tail. */
export function sliceText(text: StreamText, start = 0, end = text.length): string {
  if (typeof text === "string") return text.slice(start, end);
  const startIndex = Math.trunc(start) || 0;
  const endIndex = Math.trunc(end) || 0;
  const from = Math.max(0, startIndex < 0 ? text.length + startIndex : startIndex);
  const to = Math.min(text.length, endIndex < 0 ? text.length + endIndex : endIndex);
  const parts: string[] = [];
  let position = 0;
  for (let index = 0; index < text.blockCount && position < to; index++) {
    const block = text.groups[Math.floor(index / textGroupSize)]![index]!;
    if (position + block.length > from) {
      parts.push(block.slice(Math.max(0, from - position), to - position));
    }
    position += block.length;
  }
  return parts.join("");
}

/** Bound a transient preview without flattening or changing its recorded source. */
export function takeText(text: StreamText, limit: number): StreamText {
  if (text.length <= limit) return text;
  if (typeof text === "string") return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  const groups: ChunkedText["groups"] = {};
  let length = 0;
  let blockCount = 0;
  for (const [key, group] of Object.entries(text.groups)) {
    const kept: Record<string, string> = {};
    let complete = true;
    for (const [index, block] of Object.entries(group)) {
      const prefix = block.slice(0, limit - length).replace(/[\uD800-\uDBFF]$/, "");
      if (prefix === "") {
        complete = false;
        break;
      }
      kept[index] = prefix;
      length += prefix.length;
      blockCount += 1;
      if (prefix.length < block.length) {
        complete = false;
        break;
      }
    }
    if (Object.keys(kept).length === 0) break;
    groups[key] = complete ? group : kept;
    if (!complete || length >= limit) break;
  }
  const last = groups[Math.floor((blockCount - 1) / textGroupSize)]?.[blockCount - 1] ?? "";
  return { length, blockCount, tailOffset: last.length, groups };
}
