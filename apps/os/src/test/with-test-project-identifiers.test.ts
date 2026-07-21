import { describe, expect, test, vi } from "vitest";
import {
  freshTestProjectId,
  withTestProjectIdentifiers,
} from "../../e2e/test-support/with-test-project-identifiers.ts";

function createSession() {
  const create = vi.fn((input: { projectId?: string; slug: string }) => input);
  const session = {
    dup: vi.fn(),
    projects: { create },
    [Symbol.dispose]: vi.fn(),
  };
  session.dup.mockReturnValue(session);
  return { create, session };
}

describe("withTestProjectIdentifiers", () => {
  test("gives every project create a collision-resistant caller-owned id", () => {
    const { create, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.projects.create({ slug: "parallel-e2e" });

    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
      slug: "parallel-e2e",
    });
  });

  test("preserves an explicit project id", () => {
    const { create, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.projects.create({ projectId: "prj_explicit", slug: "explicit" });

    expect(create).toHaveBeenCalledWith({
      projectId: "prj_explicit",
      slug: "explicit",
    });
  });

  test("wraps the session returned by authenticate", () => {
    const { create, session } = createSession();
    const root = {
      authenticate: vi.fn((_credentials: { type: string }) => session),
      [Symbol.dispose]: vi.fn(),
    };

    const authenticated = withTestProjectIdentifiers(root).authenticate({ type: "test" });
    authenticated.projects.create({ slug: "authenticated" });

    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
      slug: "authenticated",
    });
  });

  test("keeps duplicate sessions inside the identifier boundary", () => {
    const { create, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.dup().projects.create({ slug: "duplicate" });

    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
      slug: "duplicate",
    });
  });

  test("disposes the underlying session with its original receiver", () => {
    const { session } = createSession();
    let disposeReceiver: unknown;
    session[Symbol.dispose].mockImplementation(function (this: unknown) {
      disposeReceiver = this;
    });

    withTestProjectIdentifiers(session)[Symbol.dispose]();

    expect(session[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(disposeReceiver).toBe(session);
  });

  test("generates a new valid id for each call", () => {
    const first = freshTestProjectId();
    const second = freshTestProjectId();

    expect(first).toMatch(/^prj_[0-9a-f]{32}$/);
    expect(second).toMatch(/^prj_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });
});
