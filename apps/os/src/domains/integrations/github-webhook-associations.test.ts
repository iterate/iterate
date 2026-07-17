import { describe, expect, it } from "vitest";
import { githubWebhookAssociations } from "./github-webhook-associations.ts";

const repository = {
  id: 101,
  name: "widgets",
  owner: { login: "acme" },
};

describe("githubWebhookAssociations", () => {
  it.each([
    ["pull_request", { pull_request: { number: 7 } }],
    ["pull_request_review", { pull_request: { number: 7 }, review: {} }],
    ["pull_request_review_comment", { comment: {}, pull_request: { number: 7 } }],
    ["pull_request_review_thread", { pull_request: { number: 7 }, thread: {} }],
    [
      "issue_comment",
      { comment: {}, issue: { number: 7, pull_request: { url: "https://example.test/7" } } },
    ],
  ])("associates a %s delivery with its subject pull request", (name, payload) => {
    expect(
      githubWebhookAssociations({ id: "delivery-1", name, payload: { ...payload, repository } }),
    ).toMatchObject({
      pullRequest: { number: 7 },
      repository: { id: 101, owner: "acme", repo: "widgets" },
    });
  });

  it("keeps plain issues and unrelated events out of pull-request routing", () => {
    expect(
      githubWebhookAssociations({
        id: "delivery-1",
        name: "issue_comment",
        payload: { comment: {}, issue: { number: 7 }, repository },
      }),
    ).not.toHaveProperty("pullRequest");
    expect(githubWebhookAssociations({ id: "delivery-2", name: "check_run", payload: {} })).toEqual(
      {},
    );
  });

  it("keeps malformed recognized deliveries out of pull-request routing", () => {
    expect(
      githubWebhookAssociations({
        id: "delivery-1",
        name: "pull_request",
        payload: { repository },
      }),
    ).toEqual({
      mentionedUsers: [],
      repository: { id: 101, owner: "acme", repo: "widgets" },
    });
    expect(
      githubWebhookAssociations({
        id: "delivery-2",
        name: "pull_request",
        payload: { repository: { id: 101, owner: { login: "acme" } } },
      }),
    ).toEqual({});
  });

  it("extracts only the content author and complete GitHub mentions", () => {
    expect(
      githubWebhookAssociations({
        id: "delivery-1",
        name: "issue_comment",
        payload: {
          comment: {
            author_association: "MEMBER",
            body: "@Iterate please review with @alice, not @iterate_extra or person@example.com",
            user: { login: "jonas", type: "User" },
          },
          issue: { number: 7, pull_request: {} },
          repository,
        },
      }),
    ).toMatchObject({
      author: { association: "MEMBER", login: "jonas", type: "User" },
      mentionedUsers: ["iterate", "alice"],
    });
  });
});
