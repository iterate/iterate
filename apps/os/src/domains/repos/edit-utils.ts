export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

export function replaceLiteralOccurrences(input: {
  content: string;
  newString: string;
  oldString: string;
}): string {
  return input.content.split(input.oldString).join(input.newString);
}
