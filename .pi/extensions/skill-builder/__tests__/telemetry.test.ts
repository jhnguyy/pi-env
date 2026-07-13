import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runSkillBuild } from "../index";
import {
  MAX_TOOLING_STRING_LENGTH,
  TOOLING_OTEL_BOUNDS,
  resolveToolingOtelConfig,
  sanitizeToolingAttributes,
} from "../../../../src/telemetry/tooling.js";
import { DEFAULT_BOUNDED_OTEL_BOUNDS } from "../../../../src/telemetry/otel.js";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function modelConfig() {
  return {
    provider: "test-provider",
    model: "test-model",
    costModel: "api" as const,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  };
}

function inMemoryExporter(finished: ReadableSpan[]): SpanExporter {
  return {
    export: (spans, callback) => {
      finished.push(...spans);
      callback({ code: 0 });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

function writeReviewSkill(root: string, body: string): void {
  const skillDir = join(root, "review-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: review-skill\ndescription: Reviews one skill for specific actionable quality problems.\n---\n\n${body}\n`,
  );
}

describe("skill-builder tooling telemetry", () => {
  it("keeps tooling attributes bounded and rejects sensitive or high-cardinality fields", () => {
    const attributes = sanitizeToolingAttributes({
      operation: "x".repeat(500),
      mode: "review",
      outcome: "success",
      path: "/secret/worktree/SKILL.md",
      content: "secret skill content",
      diff: "secret diff",
      prompt: "secret prompt",
      stdout: "secret stdout",
      stderr: "secret stderr",
      endpoint: "http://user:pass@collector:4318?token=secret",
      input_tokens: 100,
      cost: 42,
      secret: "bearer-secret",
    });

    expect(attributes).toEqual({
      operation: "x".repeat(MAX_TOOLING_STRING_LENGTH),
      mode: "review",
      outcome: "success",
    });
    expect(JSON.stringify(attributes)).not.toContain("secret");
    expect(TOOLING_OTEL_BOUNDS).toBe(DEFAULT_BOUNDED_OTEL_BOUNDS);
    expect(TOOLING_OTEL_BOUNDS.maxQueueSize).toBeLessThanOrEqual(64);
    expect(TOOLING_OTEL_BOUNDS.maxExportBatchSize).toBeLessThanOrEqual(
      TOOLING_OTEL_BOUNDS.maxQueueSize,
    );
  });

  it("normalizes enabled endpoints without retaining credentials, query strings, or fragments", async () => {
    const config = await Effect.runPromise(
      resolveToolingOtelConfig({
        PI_ENV_TOOLING_OTEL_ENABLED: "yes",
        PI_ENV_TOOLING_OTEL_ENDPOINT:
          "https://user:pass@collector.example:4318/custom/?token=secret#fragment",
      }),
    );

    expect(config).toEqual({
      enabled: true,
      endpoint: "https://collector.example:4318/custom",
    });
    expect(JSON.stringify(config)).not.toMatch(/user|pass|token|secret|fragment/);
  });

  it("exports bounded review spans without skill, diff, prompt, path, or process output", async () => {
    const root = tempRoot("skill-builder-secret-path-");
    const contentSentinel = "secret-content-sentinel";
    const diffSentinel = "secret-diff-sentinel";
    const stdoutSentinel = "secret-stdout-sentinel";
    writeReviewSkill(root, `# Review\n\n${contentSentinel}`);

    const finished: ReadableSpan[] = [];
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ verdict: "pass", findings: [], ignored: stdoutSentinel }),
      stderr: "",
    }));

    const result = await runSkillBuild(
      { exec } as any,
      { path: "review-skill", diff: diffSentinel },
      {
        cwd: root,
        modelConfig: modelConfig(),
        env: {
          PI_ENV_TOOLING_OTEL_ENABLED: "true",
          PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318/",
        },
        telemetryExporter: inMemoryExporter(finished),
      },
    );

    expect(result.content[0]?.text).toContain("✓ Evaluate: pass");
    expect(exec).toHaveBeenCalledOnce();
    expect(finished.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "tooling.skill_build.validate",
        "tooling.skill_build.evaluate",
        "tooling.skill_build.workflow",
      ]),
    );

    const workflow = finished.find((span) => span.name === "tooling.skill_build.workflow");
    expect(workflow?.attributes).toMatchObject({
      operation: "skill_build",
      mode: "review",
      outcome: "success",
      verdict: "pass",
      finding_count: 0,
      provider: "test-provider",
      model: "test-model",
      cost_model: "api",
    });

    const exported = JSON.stringify(
      finished.map((span) => ({ name: span.name, attributes: span.attributes })),
    );
    for (const sentinel of [root, contentSentinel, diffSentinel, stdoutSentinel]) {
      expect(exported).not.toContain(sentinel);
    }
  });

  it("does not export raw operational errors", async () => {
    const root = tempRoot("skill-builder-error-redaction-");
    writeReviewSkill(root, "# Review");
    const errorSentinel = "raw-error-secret-sentinel";
    const finished: ReadableSpan[] = [];
    const exec = vi.fn(async () => {
      throw new Error(errorSentinel);
    });

    await expect(
      runSkillBuild(
        { exec } as any,
        { path: "review-skill" },
        {
          cwd: root,
          modelConfig: modelConfig(),
          env: {
            PI_ENV_TOOLING_OTEL_ENABLED: "true",
            PI_ENV_TOOLING_OTEL_ENDPOINT: "http://collector:4318",
          },
          telemetryExporter: inMemoryExporter(finished),
        },
      ),
    ).rejects.toMatchObject({
      _tag: "SkillBuildOperationalError",
      operation: "evaluate",
      message: "Skill evaluation failed",
    });

    const exported = JSON.stringify(
      finished.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(exported).not.toContain(errorSentinel);
  });

  it("keeps telemetry disabled by default even when an exporter seam is present", async () => {
    const root = tempRoot("skill-builder-disabled-");
    const finished: ReadableSpan[] = [];
    const exec = vi.fn();

    const result = await runSkillBuild(
      { exec } as any,
      {
        name: "disabled-telemetry",
        description: "Creates a focused skill while telemetry remains disabled by default.",
        template: "basic",
        targetDir: "skills",
      },
      {
        cwd: root,
        modelConfig: modelConfig(),
        env: {},
        telemetryExporter: inMemoryExporter(finished),
      },
    );

    expect(result.content[0]?.text).toContain("✓ Scaffolded");
    expect(exec).not.toHaveBeenCalled();
    expect(finished).toEqual([]);
  });

  it("rejects explicit invalid telemetry configuration before workflow IO", async () => {
    const root = tempRoot("skill-builder-invalid-otel-");
    const exec = vi.fn();

    await expect(
      runSkillBuild(
        { exec } as any,
        {
          name: "invalid-telemetry",
          description: "Creates a focused skill only after telemetry configuration is valid.",
          template: "basic",
          targetDir: "skills",
        },
        {
          cwd: root,
          modelConfig: modelConfig(),
          env: { PI_ENV_TOOLING_OTEL_ENABLED: "true" },
        },
      ),
    ).rejects.toThrow("must be an http(s) URL");

    expect(exec).not.toHaveBeenCalled();
  });
});
