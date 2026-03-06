import { redirect, useLoaderData } from "react-router";
import { getSortedDocsPages } from "../lib/docs.ts";
import BlogLayout from "../components/blog-layout.tsx";

export async function loader() {
  const pages = await getSortedDocsPages();
  const firstPage = pages[0];
  if (firstPage) {
    throw redirect(`/docs/${firstPage.slug}`);
  }
  return { pages };
}

export default function DocsIndexPage() {
  const { pages } = useLoaderData<typeof loader>();

  return (
    <BlogLayout>
      <div className="w-full">
        <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">Documentation</h1>
        {pages.length === 0 && (
          <p className="text-gray-600">No documentation pages yet. Check back soon!</p>
        )}
      </div>
    </BlogLayout>
  );
}
