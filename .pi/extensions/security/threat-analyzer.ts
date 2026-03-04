/**
 * ThreatAnalyzer — scans tool calls against threat descriptors.
 *
 * Pure analysis, no side effects. Returns a list of matched threats
 * that the engine uses to escalate permission levels.
 */

import { ALL_THREAT_DESCRIPTORS } from "./threat-descriptors";
import type { ThreatDescriptor, ThreatMatch, ToolInput } from "./types";
import { resolveFieldValue } from "./types";

export class ThreatAnalyzer {
  private descriptors: ThreatDescriptor[];

  constructor(descriptors: ThreatDescriptor[] = ALL_THREAT_DESCRIPTORS) {
    this.descriptors = descriptors;
  }

  /** Analyze a tool call and return all matching threats */
  analyze(tool: string, input: ToolInput): ThreatMatch[] {
    const matches: ThreatMatch[] = [];

    for (const descriptor of this.descriptors) {
      if (!this.appliesToTool(descriptor, tool)) continue;

      const value = resolveFieldValue(tool, input, descriptor.field);
      if (!value) continue;

      const match = descriptor.pattern.exec(value);
      if (match) {
        matches.push({
          descriptor,
          matchedText: match[0],
        });
      }
    }

    return matches;
  }

  /** Check if a descriptor applies to the given tool */
  private appliesToTool(descriptor: ThreatDescriptor, tool: string): boolean {
    return descriptor.tools.includes("*") || descriptor.tools.includes(tool);
  }

  /** Total number of loaded descriptors (for status display) */
  getDescriptorCount(): number {
    return this.descriptors.length;
  }
}
