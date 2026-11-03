import { expect, it } from "vitest";
import { extractGitHubPullRequestUrl, parseGitHubPullRequestUrl } from "../_shared/github";

it("extracts an embedded PR URL without accepting overlong PR numbers", () => {
  expect(
    extractGitHubPullRequestUrl("Review this PR https://github.com/acme/widgets/pull/123 please"),
  ).toBe("https://github.com/acme/widgets/pull/123");
  expect(
    extractGitHubPullRequestUrl(
      "Review this PR https://github.com/acme/widgets/pull/12345678901 please",
    ),
  ).toBeUndefined();
});
it("parses and canonicalizes GitHub PR URLs", () => {
  expect(
    parseGitHubPullRequestUrl("https://github.com/acme/widgets/pull/123/files?x#anchor"),
  ).toEqual({
    owner: "acme",
    repo: "widgets",
    number: 123,
    url: "https://github.com/acme/widgets/pull/123",
  });
});
it.each([
  "https://github.com/-bad/widgets/pull/1",
  "https://github.com/../widgets/pull/1",
  "https://github.com/%2e%2e/widgets/pull/1",
  "https://github.com/acme/widgets/pull/0",
  "https://github.com/acme/widgets/pull/12345678901",
  "http://github.com/acme/widgets/pull/1",
  "https://example.com/acme/widgets/pull/1",
])("rejects invalid PR reference %s", (url) => {
  expect(parseGitHubPullRequestUrl(url)).toBeUndefined();
});
