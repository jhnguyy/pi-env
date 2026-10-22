import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onTestFinished } from "vitest";
import { managedGitExec } from "../../snapshot";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Local divergent history. Only the remote URL and GitHub metadata cross a fake boundary. */
export function reviewRepo(headPath = "head.txt", headContent = "head\n") {
  const root = mkdtempSync(join(tmpdir(), "pi-review-repo-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", "trunk", source);
  git(source, "config", "user.name", "Review Fixture");
  git(source, "config", "user.email", "review@example.invalid");
  writeFileSync(join(source, "shared.txt"), "shared\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "common");
  const commonOid = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "base.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const baseOid = git(source, "rev-parse", "HEAD");
  git(source, "switch", "-qc", "feature", commonOid);
  writeFileSync(join(source, headPath), headContent);
  git(source, "add", ".");
  git(source, "commit", "-qm", "head");
  const headOid = git(source, "rev-parse", "HEAD");
  git(root, "init", "-q", "--bare", origin);
  git(source, "remote", "add", "fixture", `file://${origin}`);
  git(
    source,
    "push",
    "-q",
    "fixture",
    `${baseOid}:refs/heads/trunk`,
    `${headOid}:refs/pull/7/head`,
  );
  const metadata = {
    owner: "acme",
    repo: "widgets",
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    baseRef: "trunk",
    baseOid,
    headOid,
    changedFiles: [],
  };
  const localExec: ExtensionAPI["exec"] = (command, rawArgs, options = {}) => {
    if (command !== "git") throw new Error(`Unexpected local command: ${command}`);
    const args = [...rawArgs];
    if (args[0] === "remote" && ["add", "set-url"].includes(args[1] ?? ""))
      args[args.length - 1] = `file://${origin}`;
    return managedGitExec(command, args, options);
  };
  const exec: ExtensionAPI["exec"] = (command, args, options) => {
    if (command === "gh" && args[0] === "pr" && args[1] === "view")
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          ...metadata,
          baseRefName: metadata.baseRef,
          baseRefOid: metadata.baseOid,
          headRefOid: metadata.headOid,
        }),
        stderr: "",
        killed: false,
      });
    return localExec(command, args, options);
  };
  return { root, source, commonOid, metadata, localExec, exec, origin };
}
