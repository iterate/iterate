const MAX_PREVIEW_LENGTH = 44;

export function summarizeCodeSnippet(code: string) {
  const firstMeaningfulLine =
    code
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "Untitled snippet";

  return truncate(firstMeaningfulLine);
}

export function summarizeResult(result: string) {
  return truncate(result.replace(/\s+/g, " ").trim() || "No result");
}

function truncate(value: string) {
  return value.length > MAX_PREVIEW_LENGTH ? `${value.slice(0, MAX_PREVIEW_LENGTH - 1)}...` : value;
}
