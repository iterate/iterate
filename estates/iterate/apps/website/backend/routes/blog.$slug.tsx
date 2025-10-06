import { useLoaderData } from "react-router";
import { getPostData } from "../lib/blog.ts";
import { markdownToHtml } from "../lib/mdx.ts";
import { formatDate } from "../utils/date.ts";
import BlogLayout from "../components/blog-layout.tsx";
import { Link } from "../components/link.tsx";

export async function loader({ params }: { params: { slug: string } }) {
  const post = await getPostData(params.slug);
  if (!post) {
    throw new Response("Not Found", { status: 404 });
  }
  const contentHtml = await markdownToHtml(post.content, "blog");
  return { post, contentHtml };
}

export default function BlogPost() {
  const { post, contentHtml } = useLoaderData<typeof loader>();

  return (
    <BlogLayout>
      <article className="w-full">
        <div className="mb-8">
          <Link to="/blog" className="text-sm mb-4 inline-block">
            ← Back to blog
          </Link>
          <h1 className="text-3xl font-bold mb-2 text-gray-900 headline-mark">{post.title}</h1>
          <time className="text-sm text-gray-500 block">{formatDate(post.date)}</time>
        </div>

        <div
          className="prose prose-lg max-w-none"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Needs to be there for MDX
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      </article>
    </BlogLayout>
  );
}
