import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

export type ToolProgress = (message: string) => void;

export interface DomainToolContext {
  cwd: string;
  signal?: AbortSignal;
  progress?: ToolProgress;
}

export interface DomainToolResult<Details = unknown> {
  content: (TextContent | ImageContent)[];
  details: Details;
}

export type DomainToolExecutor<Params, Details = unknown> = (
  params: Params,
  context: DomainToolContext,
) => Promise<DomainToolResult<Details>>;

export interface ToolContract<Params, Details = unknown, Schema extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  execute: DomainToolExecutor<Params, Details>;
}
