interface StreamStagingEnv {
  STREAM: DurableObjectNamespace<import("./workers/durable-objects/stream").Stream>;
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<
    import("./workers/durable-objects/stream-processor-runner").StreamProcessorRunner
  >;
}

interface Env extends StreamStagingEnv {}

declare namespace Cloudflare {
  interface Env extends StreamStagingEnv {}
}
