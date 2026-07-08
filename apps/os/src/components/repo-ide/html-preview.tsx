/**
 * The Preview half of the repo IDE's Code/Preview toggle for html files:
 * renders the current buffer (unsaved working-tree edits included) in a
 * sandboxed iframe.
 *
 * Sandbox stance: `allow-scripts` and NOTHING else — crucially no
 * `allow-same-origin`, so the document runs in an opaque origin and its
 * scripts cannot reach the dashboard's cookies, storage, or DOM. Repo HTML is
 * user-supplied, but the viewer is the same user who could run the file
 * anywhere; interactive previews are half the point of an html renderer.
 * Top navigation, popups, forms, and modals stay denied, and no-referrer
 * keeps subresource requests from learning the dashboard URL.
 *
 * srcdoc, not a blob URL: the Chrome quirk that forced the PDF renderer onto
 * blob URLs is specific to the PDF viewer. srcdoc carries the live buffer
 * with no object-URL lifecycle to manage.
 */
export function HtmlPreview({ html }: { html: string }) {
  return (
    <iframe
      title="HTML preview"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      // White canvas: standalone html assumes a browser-default white page,
      // and iframes are transparent by default (ugly against a dark app).
      className="min-h-0 flex-1 bg-white"
    />
  );
}

/** Only real html documents get the Code/Preview toggle — .svg also opens as
 * html-highlighted text but is an image format, not a page. */
export function isHtmlPreviewPath(path: string): boolean {
  return /\.html?$/i.test(path);
}
