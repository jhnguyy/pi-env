import { LinearClient } from "@linear/sdk";
import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  LinearSdkApi,
  type LinearSdkClientFactory,
  type LinearSdkClientOptions,
} from "../sdk-adapter";

describeIfEnabled("linear", "Linear SDK authentication adapter", () => {
  it("initializes the SDK with an API key instead of an OAuth access token", () => {
    const signal = new AbortController().signal;
    let clientOptions: LinearSdkClientOptions | undefined;
    const createClient: LinearSdkClientFactory = (options) => {
      clientOptions = options;
      return new LinearClient(options);
    };

    new LinearSdkApi("linear-api-key", signal, createClient);

    expect(clientOptions).toEqual({ apiKey: "linear-api-key", signal });
    expect(clientOptions).not.toHaveProperty("accessToken");
  });
});
