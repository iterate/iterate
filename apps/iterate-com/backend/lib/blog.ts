import matter from "gray-matter";

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  content: string;
}

function getSlugFromPath(filePath: string): string {
  const fileName = filePath.split("/").pop() || "";
  return fileName.replace(".md", "");
}

export async function getSortedPostsData(): Promise<BlogPost[]> {
  const postsGlob = import.meta.glob("../content/blog/*.md", { as: "raw" });
  const entries = Object.entries(postsGlob);
  const allPostsData = await Promise.all(
    entries.map(async ([filePath, getContent]) => {
      const content = await getContent();
      const slug = getSlugFromPath(filePath);
      const matterResult = matter(content);
      return {
        slug,
        title: matterResult.data.title || slug,
        date: matterResult.data.date || new Date().toISOString(),
        excerpt: matterResult.data.excerpt || "",
        content: matterResult.content,
      };
    }),
  );
  return allPostsData.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function getPostData(slug: string): Promise<BlogPost | null> {
  const postsGlob = import.meta.glob("../content/blog/*.md", { as: "raw" });
  const filePath = `../content/blog/${slug}.md`;
  const getContent = postsGlob[filePath];
  if (!getContent) {
    return null;
  }
  const content = await getContent();
  const matterResult = matter(content);
  return {
    slug,
    title: matterResult.data.title || slug,
    date: matterResult.data.date || new Date().toISOString(),
    excerpt: matterResult.data.excerpt || "",
    content: matterResult.content,
  };
}
