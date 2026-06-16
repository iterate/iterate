import { formatDurableObjectName } from "~/domains/durable-object-names.ts";

export type RepoReference = {
  projectId: string | null;
  path: string;
};

export function repoArtifactName(input: RepoReference) {
  const ref = formatDurableObjectName(input);
  return `repo-${hexEncode(ref)}`;
}

function hexEncode(value: string) {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
