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
