import { expect, it } from "vitest";
import { AnnotationType } from "@plannotator/ui/types";
import {
  WORKSPACE_ANNOTATION_EVENT_PREFIX,
  WorkspaceAnnotationJournal,
  workspaceAnnotationSnapshot,
} from "./workspace-annotations.ts";

it("folds one task's durable review events into its current annotation snapshot", () => {
  const first = annotation({ id: "ann-1", text: "Please make this measurable." });
  const otherTask = annotation({ id: "ann-other", text: "Unrelated." });

  expect(
    workspaceAnnotationSnapshot(
      [
        event(1, "annotation-added", "tasks/launch.md", { annotation: first }),
        event(2, "annotation-added", "tasks/other.md", { annotation: otherTask }),
        event(3, "annotation-updated", "tasks/launch.md", {
          id: first.id,
          updates: { text: "Please add a concrete success metric." },
        }),
        event(4, "annotation-added", "tasks/launch.md", {
          annotation: annotation({ id: "ann-2", text: "Keep this paragraph." }),
        }),
        event(5, "annotation-removed", "tasks/launch.md", { id: first.id }),
      ],
      "tasks/launch.md",
    ),
  ).toMatchObject({
    annotations: [{ id: "ann-2", text: "Keep this paragraph." }],
    version: 5,
  });
});

it("stamps a new review annotation with the verified Iterate user", async () => {
  const recorded: unknown[] = [];
  const journal = new WorkspaceAnnotationJournal({
    append: async (...events) => {
      recorded.push(...events);
    },
    getEvents: async () => [],
    verifiedAuthor: "Ada",
  });

  const created = await journal.add(
    "/tasks/launch.md",
    annotation({ author: "Mallory", id: "ann-1", text: "Please make this measurable." }),
  );

  expect(created).toMatchObject({ author: "Ada", id: "ann-1" });
  expect(recorded).toMatchObject([
    {
      payload: {
        annotation: { author: "Ada", id: "ann-1" },
        path: "tasks/launch.md",
      },
      type: `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-added`,
    },
  ]);
});

it("accepts Plannotator's document-level comment shape", () => {
  const globalComment = {
    ...annotation({ id: "global-1", text: "This applies to the whole task." }),
    blockId: "",
    endOffset: 0,
    originalText: "",
    startOffset: 0,
    type: AnnotationType.GLOBAL_COMMENT,
  };

  expect(
    workspaceAnnotationSnapshot(
      [event(1, "annotation-added", "tasks/launch.md", { annotation: globalComment })],
      "tasks/launch.md",
    ),
  ).toMatchObject({
    annotations: [{ id: "global-1", type: AnnotationType.GLOBAL_COMMENT }],
  });
});

it("reads every page before folding a busy workspace's review journal", async () => {
  const history = Array.from({ length: 501 }, (_, index) =>
    event(index + 1, "annotation-added", "tasks/launch.md", {
      annotation: annotation({ id: `ann-${index + 1}`, text: `Comment ${index + 1}` }),
    }),
  );
  const reads: number[] = [];
  const journal = new WorkspaceAnnotationJournal({
    append: async () => undefined,
    getEvents: async (afterOffset) => {
      reads.push(afterOffset);
      return history.filter((item) => item.offset > afterOffset).slice(0, 500);
    },
    verifiedAuthor: "Ada",
  });

  const snapshot = await journal.snapshot("tasks/launch.md");

  expect(snapshot).toMatchObject({ version: 501 });
  expect(snapshot.annotations).toHaveLength(501);
  expect(snapshot.annotations).toContainEqual(expect.objectContaining({ id: "ann-501" }));
  expect(reads).toEqual([0, 500]);
});

function annotation(input: { author?: string; id: string; text: string }) {
  return {
    author: "Ada",
    ...input,
    blockId: "block-1",
    createdA: 1,
    endOffset: 4,
    originalText: "ship",
    startOffset: 0,
    type: AnnotationType.COMMENT,
  };
}

function event(
  offset: number,
  operation: "annotation-added" | "annotation-updated" | "annotation-removed",
  path: string,
  fields: Record<string, unknown>,
) {
  return {
    createdAt: `2026-07-24T10:00:0${offset}.000Z`,
    offset,
    payload: { path, ...fields },
    type: `events.iterate.com/tasks/plannotator/${operation}`,
  };
}
