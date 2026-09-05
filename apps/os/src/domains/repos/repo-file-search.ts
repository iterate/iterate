import type { SearchRepoFilesInput } from "./types.ts";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const MAX_SEARCH_QUERY_LENGTH = 256;
const PATH_SEGMENT_BOUNDARIES = "/._-";

/** Validate the public repo search command before it reaches ranking code. */
export function parseSearchRepoFilesInput(input: SearchRepoFilesInput): {
  query: string;
  limit: number;
} {
  if (typeof input?.query !== "string") {
    throw new TypeError("repo file search query must be a string");
  }
  if (input.query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new RangeError(
      `repo file search query must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`,
    );
  }
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new RangeError(`repo file search limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }
  return { query: input.query, limit };
}

/** Path-oriented fuzzy search for the bounded public repo search result. */
export function searchRepoFilePaths(
  paths: readonly string[],
  input: SearchRepoFilesInput,
): string[] {
  const { query, limit } = parseSearchRepoFilesInput(input);
  const needle = query.toLocaleLowerCase();
  if (needle === "") return paths.toSorted().slice(0, limit);

  return paths
    .flatMap((path) => {
      const score = fuzzyPathScore(path.toLocaleLowerCase(), needle);
      return Number.isFinite(score) ? [{ path, score }] : [];
    })
    .toSorted((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map(({ path }) => path);
}

function fuzzyPathScore(path: string, needle: string): number {
  if (path === needle) return 0;
  if (path.startsWith(needle)) return 10 + path.length - needle.length;

  const contiguousIndex = path.indexOf(needle);
  if (contiguousIndex >= 0) {
    const startsSegment =
      contiguousIndex === 0 || PATH_SEGMENT_BOUNDARIES.includes(path[contiguousIndex - 1]!);
    return (startsSegment ? 25 : 50) + contiguousIndex + path.length - needle.length;
  }

  let needleIndex = 0;
  let previousMatch = -1;
  let score = 100;
  for (let index = 0; index < path.length && needleIndex < needle.length; index += 1) {
    if (path[index] !== needle[needleIndex]) continue;
    score += previousMatch < 0 ? index : index - previousMatch - 1;
    if (index === 0 || PATH_SEGMENT_BOUNDARIES.includes(path[index - 1]!)) score -= 4;
    previousMatch = index;
    needleIndex += 1;
  }
  return needleIndex === needle.length
    ? score + path.length - needle.length
    : Number.POSITIVE_INFINITY;
}
