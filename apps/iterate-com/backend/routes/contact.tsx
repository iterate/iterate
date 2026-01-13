import BlogLayout from "../components/blog-layout.tsx";
import { Link } from "../components/link.tsx";

export default function ContactUs() {
  return (
    <BlogLayout>
      <div className="max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-gray-900 headline-mark">Contact Us</h1>
        <p className="text-gray-700">
          For any issues or support, email{" "}
          <Link to="mailto:support@iterate.com" variant="underline" external>
            support@iterate.com
          </Link>
          .
        </p>
      </div>
    </BlogLayout>
  );
}
