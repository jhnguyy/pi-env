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

  it("rejects conflicting modes and action-specific options", () => {
    expect(() => parseAuthCommand("login --manual --local")).toThrow(
      "--manual and --local cannot be combined.",
    );
    expect(() => parseAuthCommand("status --write")).toThrow(
      "Unexpected options for /linear-auth status.",
    );
    expect(() => parseAuthCommand("use workspace --all")).toThrow(
      "Usage: /linear-auth use <connection>",
    );
  });

  it("rejects invalid actions, ports, and extra references", () => {
    expect(() => parseAuthCommand("connect")).toThrow("Usage: /linear-auth");
    expect(() => parseAuthCommand("login --port=0")).toThrow("--port must be an integer");
    expect(() => parseAuthCommand("logout one two")).toThrow("Unexpected argument: two");
  });
});
