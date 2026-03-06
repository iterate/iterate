import { useLoaderData } from "react-router";
import { getSortedPostsData } from "../lib/blog.ts";
import { formatDate } from "../utils/date.ts";
import BlogLayout from "../components/blog-layout.tsx";
import { Link } from "../components/link.tsx";

export async function loader() {
  const posts = await getSortedPostsData();
  return { posts };
}

export default function BlogPage() {
  const { posts } = useLoaderData<typeof loader>();

  return (
    <BlogLayout>
      <div className="w-full">
        <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">Blog</h1>

        <div className="grid gap-4">
          {posts.map((post: any) => (
            <article
              key={post.slug}
              className="bg-white p-5 border-2 border-gray-300 hover:shadow-sm transition-all"
            >
              <Link to={`/blog/${post.slug}`} className="block group" variant="subtle">
                <h2 className="text-xl font-semibold mb-2 text-gray-900 group-hover:text-blue-600 transition-colors">
                  {post.title}
                </h2>
                {post.excerpt && <p className="text-gray-600 mb-2">{post.excerpt}</p>}
                <time className="text-sm text-gray-500">{formatDate(post.date)}</time>
              </Link>
            </article>
          ))}

          {posts.length === 0 && (
            <p className="text-gray-600">No blog posts yet. Check back soon!</p>
          )}
        </div>
      </div>
    </BlogLayout>
  );
}
