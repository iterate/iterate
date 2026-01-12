import { useLoaderData } from "react-router";
import { getDocPage, getSortedDocsPages } from "../lib/docs.ts";
import { markdownToHtml } from "../lib/mdx.ts";
import BlogLayout from "../components/blog-layout.tsx";
import { Link } from "../components/link.tsx";

export async function loader({ params }: { params: { slug: string } }) {
  const [page, allPages] = await Promise.all([getDocPage(params.slug), getSortedDocsPages()]);
  if (!page) {
    throw new Response("Not Found", { status: 404 });
  }
  const contentHtml = await markdownToHtml(page.content);
  return { page, contentHtml, allPages };
}

export default function DocsPage() {
  const { page, contentHtml, allPages } = useLoaderData<typeof loader>();
  const grouped = allPages.reduce<Record<string, typeof allPages>>((acc, p) => {
    const key = p.category || "__uncategorized__";
    (acc[key] ||= []).push(p);
    return acc;
  }, {});
  const categoryOrder = ["Core concepts"]; // desired explicit heading order after uncategorized
  const categories = Object.keys(grouped).sort((a, b) => {
    // Always keep uncategorized first
    const aUncat = a === "__uncategorized__";
    const bUncat = b === "__uncategorized__";
    if (aUncat && !bUncat) return -1;
    if (bUncat && !aUncat) return 1;

    // Then apply explicit category order
    const ia = categoryOrder.indexOf(a);
    const ib = categoryOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;

    // Fallback to alphabetical
    return a.localeCompare(b);
  });

  return (
    <BlogLayout>
      <div className="w-full flex flex-col md:flex-row gap-8">
        <aside className="w-full md:w-64 flex-shrink-0">
          <nav className="md:sticky md:top-24">
            <h2 className="text-lg font-semibold mb-4 text-gray-900">Documentation</h2>
            <div className="space-y-4">
              {categories.map((cat) => (
                <div key={cat}>
                  {cat !== "__uncategorized__" ? (
                    <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">{cat}</div>
                  ) : null}
                  <ul className="space-y-2">
                    {grouped[cat].map((p) => (
                      <li key={p.slug}>
                        <Link
                          to={`/docs/${p.slug}`}
                          className={`block py-1 px-2 rounded ${
                            p.slug === page.slug
                              ? "bg-gray-100 text-gray-900 font-medium"
                              : "text-gray-600 hover:text-gray-900"
                          }`}
                          variant="subtle"
                        >
                          {p.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>
        </aside>

        <article className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">{page.title}</h1>
          <div
            className="prose prose-lg max-w-none"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Needs to be there for MDX
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
        </article>
      </div>
    </BlogLayout>
  );
}
