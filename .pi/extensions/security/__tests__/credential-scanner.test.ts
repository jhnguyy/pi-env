import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { CredentialScanner } from "../credential-scanner";

const scanner = new CredentialScanner();

describeIfEnabled("security", "CredentialScanner", () => {
  describe("isSensitiveFileName", () => {
    it("flags .env", () => {
      expect(scanner.isSensitiveFileName("/app/.env")).toBe(true);
    });

    it("flags .env.production", () => {
      expect(scanner.isSensitiveFileName("/app/.env.production")).toBe(true);
    });

    it("flags secrets.json", () => {
      expect(scanner.isSensitiveFileName("/config/secrets.json")).toBe(true);
    });

    it("flags .npmrc", () => {
      expect(scanner.isSensitiveFileName("/root/.npmrc")).toBe(true);
    });

    it("flags .netrc", () => {
      expect(scanner.isSensitiveFileName("/root/.netrc")).toBe(true);
    });

    it("flags terraform.tfstate", () => {
      expect(scanner.isSensitiveFileName("/infra/terraform.tfstate")).toBe(true);
    });

    it("does NOT flag normal files", () => {
      expect(scanner.isSensitiveFileName("src/main.ts")).toBe(false);
    });

    it("does NOT flag .env-like names in path components", () => {
      expect(scanner.isSensitiveFileName("/app/.env-test/config.ts")).toBe(false);
    });
  });
});
