export type IterateSecretReferenceMatch = {
  encoding: "raw" | "urlencoded";
  end: number;
  raw: string;
  secretKey: string;
  start: number;
};

const rawSecretReferencePattern = /getIterateSecret\(\{secretKey:\s*(?:"([^"]+)"|'([^']+)')\}\)/g;
const urlEncodedSecretReferencePattern =
  /getIterateSecret%28%7BsecretKey%3A(?:%20|\+)*(?:%22([^%]+)%22|%27([^%]+)%27)%7D%29/gi;

export function findIterateSecretReferences(input: string): IterateSecretReferenceMatch[] {
  return [
    ...collectMatches(input, rawSecretReferencePattern, "raw"),
    ...collectMatches(input, urlEncodedSecretReferencePattern, "urlencoded"),
  ].sort((left, right) => left.start - right.start);
}

export async function replaceIterateSecretReferences(args: {
  input: string;
  loadSecret: (secretKey: string) => Promise<string>;
}) {
  const matches = findIterateSecretReferences(args.input);
  if (matches.length === 0) {
    return {
      output: args.input,
      secretKeys: [] as string[],
    };
  }

  let cursor = 0;
  let output = "";
  const secretKeys: string[] = [];

  for (const match of matches) {
    output += args.input.slice(cursor, match.start);
    output += await args.loadSecret(match.secretKey);
    secretKeys.push(match.secretKey);
    cursor = match.end;
  }

  output += args.input.slice(cursor);

  return {
    output,
    secretKeys,
  };
}

function collectMatches(
  input: string,
  pattern: RegExp,
  encoding: IterateSecretReferenceMatch["encoding"],
) {
  pattern.lastIndex = 0;
  const matches: IterateSecretReferenceMatch[] = [];

  for (let match = pattern.exec(input); match != null; match = pattern.exec(input)) {
    const secretKey = match[1] ?? match[2];

    if (typeof secretKey !== "string" || secretKey.length === 0) {
      continue;
    }

    matches.push({
      encoding,
      end: match.index + match[0].length,
      raw: match[0],
      secretKey,
      start: match.index,
    });
  }

  return matches;
}
