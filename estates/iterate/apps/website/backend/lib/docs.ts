import matter from "gray-matter";

export interface DocPage {
  slug: string;
  title: string;
  content: string;
  order: number;
}

function getSlugFromPath(filePath: string): string {
  const fileName = filePath.split("/").pop() || "";
  return fileName.replace(".md", "");
}

function getOrderFromSlug(slug: string): number {
  const match = slug.match(/^(\d+)_/);
  return match ? Number.parseInt(match[1]) : 999;
}

export async function getSortedDocsPages(): Promise<DocPage[]> {
  const docsGlob = import.meta.glob("../content/docs/*.md", { as: "raw" });
  const entries = Object.entries(docsGlob);
  const allDocsData = await Promise.all(
    entries.map(async ([filePath, getContent]) => {
      const content = await getContent();
      const slug = getSlugFromPath(filePath);
      const matterResult = matter(content);
      return {
        slug,
        title: matterResult.data.title || slug.replace(/^\d+_/, "").replace(/-/g, " "),
        content: matterResult.content,
        order: getOrderFromSlug(slug),
      };
    }),
  );
  return allDocsData.sort((a, b) => a.order - b.order);
}

export async function getDocPage(slug: string): Promise<DocPage | null> {
  const docsGlob = import.meta.glob("../content/docs/*.md", { as: "raw" });
  const filePath = `../content/docs/${slug}.md`;
  const getContent = docsGlob[filePath];
  if (!getContent) {
    return null;
  }
  const content = await getContent();
  const matterResult = matter(content);
  return {
    slug,
    title: matterResult.data.title || slug.replace(/^\d+_/, "").replace(/-/g, " "),
    content: matterResult.content,
    order: getOrderFromSlug(slug),
  };
}
