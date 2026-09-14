export function HtmlDocumentPreview({ source }: { source: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="docs-html-preview mx-auto w-full max-w-4xl px-8 py-8"
        // Workspace HTML is authored by the project's own members and agents
        // and rendered on the project's own host — trusted on purpose, the
        // same posture as the file's source view.
        // react-doctor-disable-next-line react-doctor/dangerous-html-sink
        dangerouslySetInnerHTML={{ __html: source }}
      />
    </div>
  );
}
