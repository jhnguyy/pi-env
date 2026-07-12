import type { PublicAnalyzeRequest } from "./policy.js";

export const StrictContainmentKind = {
  LinuxCgroupV2: "linux-cgroup-v2",
  Unavailable: "unavailable",
} as const;
export type StrictContainmentKind =
  (typeof StrictContainmentKind)[keyof typeof StrictContainmentKind];

export type StrictContainmentReadiness =
  | {
      readonly _tag: "ready";
      readonly kind: typeof StrictContainmentKind.LinuxCgroupV2;
      readonly prepare: (request: PublicAnalyzeRequest) => Promise<void>;
    }
  | {
      readonly _tag: "unavailable";
      readonly kind: typeof StrictContainmentKind.Unavailable;
      readonly reason: "unavailable" | "permission-denied" | "unsupported";
    };

export interface StrictContainmentAdapter {
  readonly readiness: () => Promise<StrictContainmentReadiness>;
}

/** Process groups are cleanup only and are never reported as strict containment. */
export const liveStrictContainmentAdapter: StrictContainmentAdapter = {
  readiness: async () => ({
    _tag: "unavailable",
    kind: StrictContainmentKind.Unavailable,
    reason: "unavailable",
  }),
};
