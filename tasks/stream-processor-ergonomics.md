# append() in afterAppend callback

Passing in "append" to afterAppend instead of streamApi is probably cleaner, as it is so frequently used

          if (idle && state.eyes != null) {
            await streamApi.append({
              event: {
                type: "events.iterate.com/slack/reaction-requested",
                idempotencyKey: idempotencyKey("events.iterate.com/slack/reaction-requested"),
                payload: { action: "remove", ...state.eyes },
              },
            });
          }

# Composition of processors

Should be possible to compose processors. And this boilerplate for the "standard behaviour of well defined processors" should be made nicer. You could e.g. create middleware stacks of processors fairly easily (like `withStandardProcessorBehavior(...)` that adds the standard behaviour to a processor).
