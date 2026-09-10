import { beforeEach, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";

const linearClient = vi.hoisted(() => vi.fn());

vi.mock("@linear/sdk", () => ({
  LinearClient: linearClient,
  LinearError: class LinearError extends Error {},
  LinearErrorType: {
    AuthenticationError: "AuthenticationError",
    Ratelimited: "Ratelimited",
    NetworkError: "NetworkError",
    Forbidden: "Forbidden",
    InvalidInput: "InvalidInput",
    UserError: "UserError",
  },
}));

import { LinearSdkApi } from "../sdk-adapter";

describeIfEnabled("linear", "Linear SDK authentication adapter", () => {
  beforeEach(() => linearClient.mockClear());

  it("initializes the SDK with an API key instead of an OAuth access token", () => {
    const signal = new AbortController().signal;

    new LinearSdkApi("linear-api-key", signal);

    expect(linearClient).toHaveBeenCalledWith({ apiKey: "linear-api-key", signal });
    expect(linearClient).not.toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: expect.anything() }),
    );
  });
});
