import { describe, expect, test, vi } from "vitest";
import {
  freshTestProjectId,
  withTestProjectIdentifiers,
} from "../../e2e/test-support/with-test-project-identifiers.ts";

function createSession() {
  const create = vi.fn((input: { projectId?: string }) => input);
  const project = { create, [Symbol.dispose]: vi.fn() };
  const get = vi.fn((_slug: string) => project);
  const session = {
    dup: vi.fn(),
    projects: { get },
    [Symbol.dispose]: vi.fn(),
  };
  session.dup.mockReturnValue(session);
  return { create, get, project, session };
}

describe("withTestProjectIdentifiers", () => {
  test("gives every project create a collision-resistant caller-owned id", () => {
    const { create, get, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.projects.get("parallel-e2e").create({});

    expect(get).toHaveBeenCalledWith("parallel-e2e");
    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    });
  });

  test("preserves an explicit project id", () => {
    const { create, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.projects.get("explicit").create({ projectId: "prj_explicit" });

    expect(create).toHaveBeenCalledWith({
      projectId: "prj_explicit",
    });
  });

  test("wraps the session returned by authenticate", () => {
    const { create, session } = createSession();
    const root = {
      authenticate: vi.fn((_credentials: { type: string }) => session),
      [Symbol.dispose]: vi.fn(),
    };

    const authenticated = withTestProjectIdentifiers(root).authenticate({ type: "test" });
    authenticated.projects.get("authenticated").create({});

    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    });
  });

  test("keeps duplicate sessions inside the identifier boundary", () => {
    const { create, session } = createSession();
    const wrapped = withTestProjectIdentifiers(session);

    wrapped.dup().projects.get("duplicate").create({});

    expect(create).toHaveBeenCalledWith({
      projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    });
  });

  test("disposes a prospective project handle with its original receiver", () => {
    const { project, session } = createSession();
    let disposeReceiver: unknown;
    project[Symbol.dispose].mockImplementation(function (this: unknown) {
      disposeReceiver = this;
    });

    withTestProjectIdentifiers(session).projects.get("disposable")[Symbol.dispose]();

    expect(project[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(disposeReceiver).toBe(project);
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
