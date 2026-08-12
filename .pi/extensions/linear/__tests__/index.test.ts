import { expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { parseAuthCommand } from "../index";

describeIfEnabled("linear", "linear-auth command", () => {
  it("parses explicit manual write elevation and reusable app configuration", () => {
    expect(
      parseAuthCommand(
        "login --manual --write --client-id client-1 --port 43921 --name 'Work account'",
      ),
    ).toEqual({
      action: "login",
      mode: "manual",
      write: true,
      clientId: "client-1",
      callbackPort: 43_921,
      name: "Work account",
    });
  });

  it("rejects flags that have no value", () => {
    expect(() => parseAuthCommand("login --client-id")).toThrow("--client-id requires a value");
    expect(() => parseAuthCommand("login --name --write")).toThrow("--name requires a value");
  });

  it("parses connection selection and complete logout", () => {
    expect(parseAuthCommand("use example/user@example.com")).toEqual({
      action: "use",
      reference: "example/user@example.com",
    });
    expect(parseAuthCommand("logout --all")).toEqual({ action: "logout", all: true });
  });
});
