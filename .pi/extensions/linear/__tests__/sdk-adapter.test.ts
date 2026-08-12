import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { sdkResourceVariables } from "../sdk-adapter";

describeIfEnabled("linear", "Linear SDK resource adapter", () => {
  it("builds server-side filters for resource queries", () => {
    expect(sdkResourceVariables({ type: "teams", query: "Platform", limit: 20 })).toEqual({
      first: 20,
      after: undefined,
      filter: {
        or: [
          { id: { eq: "Platform" } },
          { key: { containsIgnoreCase: "Platform" } },
          { name: { containsIgnoreCase: "Platform" } },
        ],
      },
    });

    expect(
      sdkResourceVariables({
        type: "labels",
        query: "Security",
        teamId: "team-1",
        cursor: "page-2",
        limit: 10,
      }),
    ).toEqual({
      first: 10,
      after: "page-2",
      filter: {
        team: { id: { eq: "team-1" } },
        or: [{ id: { eq: "Security" } }, { name: { containsIgnoreCase: "Security" } }],
      },
    });
  });
});
