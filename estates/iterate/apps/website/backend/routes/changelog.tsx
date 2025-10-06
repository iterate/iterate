import { useLoaderData } from "react-router";
import { getSortedChangelogEntries } from "../lib/changelog.ts";
import { markdownToHtml } from "../lib/mdx.ts";
import { formatDate } from "../utils/date.ts";
import BlogLayout from "../components/blog-layout.tsx";

export async function loader() {
  const entries = await getSortedChangelogEntries();
  const entriesWithHtml = await Promise.all(
    entries.map(async (entry) => ({
      date: entry.date,
      contentHtml: await markdownToHtml(entry.content, "changelog"),
    })),
  );
  return { entries: entriesWithHtml };
}

export default function ChangelogPage() {
  const { entries } = useLoaderData<typeof loader>();

  return (
    <BlogLayout>
      <div className="w-full">
        <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">Changelog</h1>

        <div className="space-y-12">
          {entries.map((entry) => (
            <article key={entry.date} className="border-b border-gray-200 pb-8 last:border-b-0">
              <h2 className="text-2xl font-semibold mb-4 text-gray-900">
                {formatDate(entry.date)}
              </h2>
              <div
                className="prose prose-lg max-w-none"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Needs to be there for MDX
                dangerouslySetInnerHTML={{ __html: entry.contentHtml }}
              />
            </article>
          ))}

          {entries.length === 0 && (
            <p className="text-gray-600">No changelog entries yet. Check back soon!</p>
          )}
        </div>
      </div>
    </BlogLayout>
  );
}
