import { Schema } from "effect";
import { MAX_TOOL_CALLS, PtcAction } from "./types";

export const PTC_DETAILS_SCHEMA_VERSION = 1 as const;
const MAX_DETAIL_TOOL_NAME_LENGTH = 80;

export const PtcCompletion = {
  Success: "success",
  Failure: "failure",
} as const;
export type PtcCompletion = (typeof PtcCompletion)[keyof typeof PtcCompletion];

export const PtcFailureClass = {
  Preparation: "preparation",
  Transformation: "transformation",
  UserScript: "user-script",
  NestedTool: "nested-tool",
  Timeout: "timeout",
  Cancellation: "cancellation",
  Infrastructure: "infrastructure",
} as const;
export type PtcFailureClass = (typeof PtcFailureClass)[keyof typeof PtcFailureClass];

export const PtcNestedCallStatus = {
  Pending: "pending",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type PtcNestedCallStatus =
  (typeof PtcNestedCallStatus)[keyof typeof PtcNestedCallStatus];

const PtcToolCallCountSchema = Schema.Struct({
  tool: Schema.String,
  count: Schema.Number,
});

const PtcLastNestedCallSchema = Schema.Struct({
  tool: Schema.String,
  ordinal: Schema.Number,
  status: Schema.Union([
    Schema.Literal(PtcNestedCallStatus.Pending),
    Schema.Literal(PtcNestedCallStatus.Succeeded),
    Schema.Literal(PtcNestedCallStatus.Failed),
  ]),
});

export const PtcRunDetailsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PTC_DETAILS_SCHEMA_VERSION),
  action: Schema.Literal(PtcAction.Run),
  completion: Schema.Union([
    Schema.Literal(PtcCompletion.Success),
    Schema.Literal(PtcCompletion.Failure),
  ]),
  durationMs: Schema.Number,
  nestedCallCount: Schema.Number,
  completedNestedCallCount: Schema.Number,
  failedNestedCallCount: Schema.Number,
  toolCallCounts: Schema.Array(PtcToolCallCountSchema),
  outputTruncated: Schema.Boolean,
  lastNestedCall: Schema.optionalKey(PtcLastNestedCallSchema),
  failureClass: Schema.optionalKey(
    Schema.Union([
      Schema.Literal(PtcFailureClass.Preparation),
      Schema.Literal(PtcFailureClass.Transformation),
      Schema.Literal(PtcFailureClass.UserScript),
      Schema.Literal(PtcFailureClass.NestedTool),
      Schema.Literal(PtcFailureClass.Timeout),
      Schema.Literal(PtcFailureClass.Cancellation),
      Schema.Literal(PtcFailureClass.Infrastructure),
    ]),
  ),
});

export type PtcRunDetails = typeof PtcRunDetailsSchema.Type;

export interface PtcNestedCallHandle {
  readonly tool: string;
  readonly ordinal: number;
  status: PtcNestedCallStatus;
}

export class PtcExecutionTracker {
  private readonly startedAt: number;
  private readonly calls: PtcNestedCallHandle[] = [];
  private readonly toolCounts = new Map<string, number>();
  private outputTruncated = false;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  startNestedCall(tool: string): PtcNestedCallHandle {
    const boundedTool = boundToolName(tool);
    const call: PtcNestedCallHandle = {
      tool: boundedTool,
      ordinal: this.calls.length + 1,
      status: PtcNestedCallStatus.Pending,
    };
    if (this.calls.length < MAX_TOOL_CALLS) this.calls.push(call);
    this.toolCounts.set(boundedTool, (this.toolCounts.get(boundedTool) ?? 0) + 1);
    return call;
  }

  completeNestedCall(call: PtcNestedCallHandle, failed: boolean): void {
    call.status = failed ? PtcNestedCallStatus.Failed : PtcNestedCallStatus.Succeeded;
  }

  markOutputTruncated(): void {
    this.outputTruncated = true;
  }

  completedNestedCallCount(): number {
    return this.calls.filter((call) => call.status !== PtcNestedCallStatus.Pending).length;
  }

  details(completion: PtcCompletion, failureClass?: PtcFailureClass): PtcRunDetails {
    const elapsed = this.now() - this.startedAt;
    const completedCalls = this.calls.filter(
      (call) => call.status !== PtcNestedCallStatus.Pending,
    );
    const details: PtcRunDetails = {
      schemaVersion: PTC_DETAILS_SCHEMA_VERSION,
      action: PtcAction.Run,
      completion,
      durationMs: Number.isFinite(elapsed)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(elapsed)))
        : 0,
      nestedCallCount: this.calls.length,
      completedNestedCallCount: completedCalls.length,
      failedNestedCallCount: completedCalls.filter(
        (call) => call.status === PtcNestedCallStatus.Failed,
      ).length,
      toolCallCounts: [...this.toolCounts].slice(0, MAX_TOOL_CALLS).map(([tool, count]) => ({
        tool,
        count,
      })),
      outputTruncated: this.outputTruncated,
      ...(this.calls.at(-1) ? { lastNestedCall: { ...this.calls.at(-1)! } } : {}),
      ...(failureClass ? { failureClass } : {}),
    };
    try {
      return Schema.decodeUnknownSync(PtcRunDetailsSchema)(details);
    } catch {
      return {
        schemaVersion: PTC_DETAILS_SCHEMA_VERSION,
        action: PtcAction.Run,
        completion,
        durationMs: 0,
        nestedCallCount: 0,
        completedNestedCallCount: 0,
        failedNestedCallCount: 0,
        toolCallCounts: [],
        outputTruncated: this.outputTruncated,
        ...(failureClass ? { failureClass } : {}),
      };
    }
  }
}

export function decodePtcRunDetails(value: unknown): PtcRunDetails | undefined {
  try {
    return Schema.decodeUnknownSync(PtcRunDetailsSchema)(value);
  } catch {
    return undefined;
  }
}

function boundToolName(tool: string): string {
  return tool.length <= MAX_DETAIL_TOOL_NAME_LENGTH
    ? tool
    : `${tool.slice(0, MAX_DETAIL_TOOL_NAME_LENGTH - 1)}…`;
}
