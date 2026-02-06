import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("iterate.os.backend");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withSpan<T>(
  name: string,
  options: { attributes?: Attributes } = {},
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: options.attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: toErrorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
