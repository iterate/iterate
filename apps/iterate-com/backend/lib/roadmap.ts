import matter from "gray-matter";

export interface Roadmap {
  title: string;
  content: string;
}

export async function getRoadmapData(): Promise<Roadmap | null> {
  const roadmapGlob = import.meta.glob("../content/roadmap/roadmap.md", { as: "raw" });
  const filePath = "../content/roadmap/roadmap.md";
  const getContent = roadmapGlob[filePath];
  if (!getContent) {
    return null;
  }
  const content = await getContent();
  const matterResult = matter(content);
  return {
    title: matterResult.data.title || "Roadmap",
    content: matterResult.content,
  };
}
