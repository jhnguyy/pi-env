import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  PtcCompletion,
  PtcExecutionTracker,
  PtcFailureClass,
  PtcNestedCallStatus,
  PtcRunDetailsSchema,
} from "../execution-details";

describe("PTC execution details", () => {
  it("creates a schema-valid bounded failure record without arguments or output", () => {
    let now = 100;
    const tracker = new PtcExecutionTracker(() => now);
    const call = tracker.startNestedCall(`read-${"x".repeat(200)}`);
    tracker.completeNestedCall(call, true);
    tracker.markOutputTruncated();
    now = 112;

    const details = tracker.details(PtcCompletion.Failure, PtcFailureClass.NestedTool);
    expect(() => Schema.decodeUnknownSync(PtcRunDetailsSchema)(details)).not.toThrow();
    expect(details).toMatchObject({
      schemaVersion: 1,
      action: "run",
      completion: PtcCompletion.Failure,
      failureClass: PtcFailureClass.NestedTool,
      durationMs: 12,
      nestedCallCount: 1,
      completedNestedCallCount: 1,
      failedNestedCallCount: 1,
      outputTruncated: true,
      lastNestedCall: {
        ordinal: 1,
        status: PtcNestedCallStatus.Failed,
      },
    });
    expect(details.toolCallCounts).toHaveLength(1);
    expect(details.toolCallCounts[0].tool.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(details)).not.toMatch(/path|params|args|credential/i);
  });
});
