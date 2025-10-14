import matter from "gray-matter";

export interface ChangelogEntry {
  date: string;
  content: string;
}

function getDateFromPath(filePath: string): string {
  const fileName = filePath.split("/").pop() || "";
  return fileName.replace(".md", "");
}

export async function getSortedChangelogEntries(): Promise<ChangelogEntry[]> {
  // Prefer a single CHANGELOG.md split into date sections if present
  const singleFileGlob = import.meta.glob("../content/changelog/CHANGELOG.md", {
    as: "raw",
    eager: true,
  }) as Record<string, string>;

  const singleFileContent = Object.values(singleFileGlob)[0];
  if (singleFileContent) {
    const parsed = parseEntriesFromSingleFile(singleFileContent);
    if (parsed.length > 0) {
      return parsed.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
  }

  // Fallback: legacy per-date files like ../content/changelog/2025-10-01.md
  const changelogGlob = import.meta.glob("../content/changelog/*.md", { as: "raw" });
  const entries = Object.entries(changelogGlob);
  const allChangelogData = await Promise.all(
    entries.map(async ([filePath, getContent]) => {
      const content = await getContent();
      const date = getDateFromPath(filePath);
      const matterResult = matter(content);
      return {
        date,
        content: matterResult.content,
      };
    }),
  );
  return allChangelogData.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function parseEntriesFromSingleFile(fileContent: string): ChangelogEntry[] {
  // Split the single file by headings that look like dates: ## YYYY-MM-DD or ### YYYY-MM-DD
  const lines = fileContent.split("\n");
  const entries: ChangelogEntry[] = [];
  let currentDate: string | null = null;
  let currentContent: string[] = [];

  const flush = () => {
    if (currentDate) {
      const content = currentContent.join("\n").trim();
      if (content.length > 0) {
        entries.push({ date: currentDate, content });
      }
    }
    currentDate = null;
    currentContent = [];
  };

  const dateHeadingRegex = /^##+\s+(\d{4}-\d{2}-\d{2})\b/;

  for (const line of lines) {
    const match = line.match(dateHeadingRegex);
    if (match) {
      // Start of a new date section
      flush();
      currentDate = match[1];
      continue;
    }
    if (currentDate) {
      currentContent.push(line);
    }
  }
  // flush last section
  flush();

  return entries;
}
