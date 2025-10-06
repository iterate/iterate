import { useLoaderData } from "react-router";
import { getRoadmapData } from "../lib/roadmap.ts";
import { markdownToHtml } from "../lib/mdx.ts";
import BlogLayout from "../components/blog-layout.tsx";

export async function loader() {
  const roadmap = await getRoadmapData();
  if (!roadmap) {
    throw new Response("Not Found", { status: 404 });
  }
  const contentHtml = await markdownToHtml(roadmap.content, "roadmap");
  return { roadmap, contentHtml };
}

export default function RoadmapPage() {
  const { roadmap, contentHtml } = useLoaderData<typeof loader>();

  return (
    <BlogLayout>
      <article className="w-full">
        <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">{roadmap.title}</h1>
        <div
          className="prose prose-lg max-w-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Needs to be there for MDX
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      </article>
    </BlogLayout>
  );
}
