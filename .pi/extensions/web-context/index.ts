import {
  defineTool,
  formatSize,
  keyHint,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Data, Effect } from "effect";
import { Type } from "typebox";
import { PiEvent } from "../_shared/agent-tools";
import { registerPtcTools } from "../_shared/ptc-tools";
import { txt } from "../_shared/result";
import { injectAnthropicHostedWebTools, isAnthropicHostedWebToolsModel, loadAnthropicWebToolSettings, shouldInjectAnthropicHostedWebTools, type AnthropicWebToolSettings } from "./anthropic-tools";
import { injectOpenAIHostedWebTools, isOpenAIHostedWebToolsModel, loadOpenAIWebToolSettings, shouldInjectOpenAIHostedWebTools, type OpenAIWebToolSettings } from "./openai-tools";

export const WebFetchMode = {
  Raw: "raw",
  Text: "text",
  Metadata: "metadata",
} as const;
export type WebFetchMode = typeof WebFetchMode[keyof typeof WebFetchMode];

export interface SiteAdapter {
  id: string;
  label: string;
  match(url: URL): boolean;
  steps(url: URL, purpose?: string): string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sameHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    id: "github",
    label: "GitHub repository/content",
    match: (url) => sameHostOrSubdomain(url.hostname, "github.com"),
    steps: (url) => [
      "Prefer local repo checkout if this URL corresponds to the current workspace.",
      `Use GitHub structured endpoints before browsing: gh api ${shellQuote(url.pathname)} or curl the matching api.github.com endpoint.`,
      "For source files, prefer raw.githubusercontent.com URLs or git sparse/partial clone over rendered HTML.",
      "For issues/PRs, prefer gh issue/pr view --json ... to preserve comments, metadata, and pagination.",
    ],
  },
  {
    id: "npm",
    label: "npm package metadata",
    match: (url) => sameHostOrSubdomain(url.hostname, "npmjs.com"),
    steps: (url) => {
      const packageName = url.pathname.replace(/^\/package\//, "").split("/").filter(Boolean).join("/");
      const registryUrl = packageName ? `https://registry.npmjs.org/${packageName}` : "https://registry.npmjs.org/<package>";
      return [
        `Fetch package metadata from the registry first: ${registryUrl}`,
        "Use package tarball contents for README/source context instead of the rendered npm page.",
        "Only browse npmjs.com if visual layout or interactive account state is specifically relevant.",
      ];
    },
  },
  {
    id: "docs-site",
    label: "Documentation site",
    match: (url) => /(^|\.)(readthedocs\.io|gitbook\.io|docusaurus\.io|vitepress\.dev)$/.test(url.hostname),
    steps: (url) => [
      "Look for llms.txt, llms-full.txt, sitemap.xml, search indexes, or static markdown/source files first.",
      `Start with: curl -fsSL ${shellQuote(new URL("/llms.txt", url).toString())}`,
      `If unavailable, inspect sitemap: curl -fsSL ${shellQuote(new URL("/sitemap.xml", url).toString())}`,
      "Use the browser only for dynamic examples, client-side-only docs, or visual verification explicitly requested by the user; ask for explicit permission before calling the browser tool."
    ],
  },
];

export function parseWebUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed;
}

export function selectAdapter(url: URL): SiteAdapter | null {
  return SITE_ADAPTERS.find((adapter) => adapter.match(url)) ?? null;
}

export type WebFetch = typeof globalThis.fetch;
export interface WebFetchOptions {
  maxBytes?: number;
  mode?: WebFetchMode;
}

export const WebFetchFailureKind = {
  Url: "url",
  Request: "request",
  Body: "body",
} as const;
export type WebFetchFailureKind = typeof WebFetchFailureKind[keyof typeof WebFetchFailureKind];

export class WebFetchFailure extends Data.TaggedError("WebFetchFailure")<{
  readonly kind: WebFetchFailureKind;
  readonly url: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface WebFetchDependencies {
  readonly fetch?: WebFetch;
  readonly signal?: AbortSignal;
}

export interface WebFetchResult {
  text: string;
  url: string;
  status: number;
  contentType: string | null;
  truncated: boolean;
  mode: WebFetchMode;
  rawBytes: number;
  outputBytes: number;
}

const webFetchAcceptHeader = "text/html, text/plain, application/json, application/xml, application/rss+xml, text/*;q=0.9, */*;q=0.1";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function webFetchFailure(kind: WebFetchFailureKind, url: string, cause: unknown): WebFetchFailure {
  const label = kind === WebFetchFailureKind.Url ? "Invalid web URL" : kind === WebFetchFailureKind.Request ? "Web fetch request failed" : "Web fetch body read failed";
  return new WebFetchFailure({ kind, url, message: `${label}: ${errorMessage(cause)}`, cause });
}

function combinedAbortSignal(effectSignal: AbortSignal, callerSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (!callerSignal) return { signal: effectSignal, cleanup: () => undefined };
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onEffectAbort = () => abort(effectSignal);
  const onCallerAbort = () => abort(callerSignal);
  if (effectSignal.aborted) abort(effectSignal);
  else effectSignal.addEventListener("abort", onEffectAbort, { once: true });
  if (callerSignal.aborted) abort(callerSignal);
  else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      effectSignal.removeEventListener("abort", onEffectAbort);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function readResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw signal.reason ?? new Error("Web fetch aborted");
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Web fetch aborted");
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new Error("Web fetch aborted");
      if (done) break;
      chunks.push(value);
    }
  } catch (cause) {
    if (signal.aborted) throw signal.reason ?? cause;
    throw cause;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The lock may already be released by cancellation; ignore cleanup errors.
    }
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function fetchWebTextEffect(rawUrl: string, options: WebFetchOptions | number = {}, dependencies: WebFetchDependencies = {}): Effect.Effect<WebFetchResult, WebFetchFailure> {
  const normalizedOptions = typeof options === "number" ? { maxBytes: options } : options;
  const mode = normalizedOptions.mode ?? WebFetchMode.Text;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  return Effect.gen(function*() {
    const url = yield* Effect.try({ try: () => parseWebUrl(rawUrl), catch: (cause) => webFetchFailure(WebFetchFailureKind.Url, rawUrl, cause) });
    const response = yield* Effect.tryPromise({
      try: async (effectSignal) => {
        const { signal, cleanup } = combinedAbortSignal(effectSignal, dependencies.signal);
        try {
          return await fetchImpl(url, {
            redirect: "follow",
            signal,
            headers: { accept: webFetchAcceptHeader },
          });
        } finally {
          cleanup();
        }
      },
      catch: (cause) => webFetchFailure(WebFetchFailureKind.Request, url.toString(), cause),
    });
    const contentType = response.headers.get("content-type");
    const bytes = yield* Effect.tryPromise({
      try: async (effectSignal) => {
        const { signal, cleanup } = combinedAbortSignal(effectSignal, dependencies.signal);
        try {
          return await readResponseBytes(response, signal);
        } finally {
          cleanup();
        }
      },
      catch: (cause) => webFetchFailure(WebFetchFailureKind.Body, url.toString(), cause),
    });
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const transformed = transformFetchedText(decoded, contentType, mode);
    const limit = Math.max(1, Math.min(normalizedOptions.maxBytes ?? 100_000, 1_000_000));
    const encoded = new TextEncoder().encode(transformed);
    const truncated = encoded.byteLength > limit;
    const text = truncateUtf8(transformed, limit);
    return { text, url: response.url, status: response.status, contentType, truncated, mode, rawBytes: bytes.byteLength, outputBytes: Math.min(encoded.byteLength, limit) };
  });
}

export async function fetchWebText(rawUrl: string, options: WebFetchOptions | number = {}, signal?: AbortSignal, dependencies: WebFetchDependencies = {}): Promise<WebFetchResult> {
  const result = await Effect.runPromise(Effect.result(fetchWebTextEffect(rawUrl, options, { ...dependencies, signal })));
  if (result._tag === "Failure") throw result.failure;
  return result.success;
}

function transformFetchedText(text: string, contentType: string | null, mode: WebFetchMode): string {
  const lowerContentType = contentType?.toLowerCase() ?? "";
  switch (mode) {
    case WebFetchMode.Raw:
      return text;
    case WebFetchMode.Metadata:
      return extractMetadata(text, lowerContentType);
    case WebFetchMode.Text:
      return transformFetchedBodyText(text, lowerContentType);
  }
}

function transformFetchedBodyText(text: string, lowerContentType: string): string {
  if (lowerContentType.includes("html")) return extractHtmlText(text);
  if (lowerContentType.includes("xml") || lowerContentType.includes("rss") || lowerContentType.includes("atom")) return extractXmlText(text);
  if (lowerContentType.includes("json")) return compactJsonText(text);
  return normalizeWhitespace(text);
}

function extractMetadata(text: string, contentType: string): string {
  if (!contentType.includes("html")) return compactJsonText(text);
  const title = firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(text, /<meta\s+[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/i);
  const headings = [...text.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .slice(0, 40)
    .map((match) => `${"#".repeat(Number(match[1]))} ${htmlToPlainText(match[2] ?? "")}`)
    .filter(Boolean);
  const links = extractLinks(text).slice(0, 80).map((link) => `- ${link.text}${link.href ? ` — ${link.href}` : ""}`);
  return [title ? `# ${decodeEntities(title)}` : undefined, description ? decodeEntities(description) : undefined, headings.length ? `\n## Headings\n${headings.join("\n")}` : undefined, links.length ? `\n## Links\n${links.join("\n")}` : undefined]
    .filter(Boolean)
    .join("\n\n");
}

function extractHtmlText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:header|footer|nav|aside)\b[\s\S]*?<\/(?:header|footer|nav|aside)>/gi, " ");
  return htmlToPlainText(withoutNoise);
}

function htmlToPlainText(html: string): string {
  return normalizeWhitespace(
    decodeEntities(
      html
        .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|pre|blockquote)>/gi, "\n")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function extractXmlText(xml: string): string {
  return normalizeWhitespace(
    decodeEntities(
      xml
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<\/(?:item|entry|channel|feed)>/gi, "\n\n")
        .replace(/<\/(?:title|link|description|summary|updated|published)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function compactJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return normalizeWhitespace(text);
  }
}

function extractLinks(html: string): Array<{ text: string; href: string }> {
  return [...html.matchAll(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: decodeEntities(match[1] ?? ""), text: htmlToPlainText(match[2] ?? "").slice(0, 120) }))
    .filter((link) => link.text || link.href);
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  let output = "";
  let used = 0;
  for (const char of text) {
    const length = encoder.encode(char).byteLength;
    if (used + length > maxBytes) break;
    output += char;
    used += length;
  }
  return output;
}

export function buildContextPlan(rawUrl: string, purpose?: string): string {
  const url = parseWebUrl(rawUrl);
  const adapter = selectAdapter(url);
  const steps = adapter?.steps(url, purpose) ?? [
    "Prefer official APIs, RSS/Atom feeds, sitemap.xml, llms.txt, embedded JSON-LD, or static HTML extraction before using a browser.",
    `Try a text-first fetch: curl -fsSL ${shellQuote(url.toString())}`,
    "If the page is documentation, inspect linked source repositories or static build assets for markdown/search indexes.",
    "Use the browser only when the user explicitly asks for browsing/clicking/visual verification or the content is only available through client-side interaction; ask for explicit permission before calling the browser tool."
  ];

  const purposeLine = purpose?.trim() ? `\nPurpose: ${purpose.trim()}\n` : "";
  return [
    `Web context plan for ${url.toString()}`,
    purposeLine.trimEnd(),
    `Adapter: ${adapter ? `${adapter.id} (${adapter.label})` : "generic"}`,
    "",
    "Recommended programmatic path:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export default function webContext(pi: ExtensionAPI) {
  let anthropicSettings: AnthropicWebToolSettings | undefined;
  let openAISettings: OpenAIWebToolSettings | undefined;

  pi.on(PiEvent.BeforeProviderRequest, (event, ctx) => {
    if (isAnthropicHostedWebToolsModel(ctx.model)) {
      anthropicSettings ??= loadAnthropicWebToolSettings(ctx.cwd);
      return shouldInjectAnthropicHostedWebTools(ctx.model, anthropicSettings) ? injectAnthropicHostedWebTools(event.payload, anthropicSettings) : undefined;
    }

    if (isOpenAIHostedWebToolsModel(ctx.model)) {
      openAISettings ??= loadOpenAIWebToolSettings(ctx.cwd);
      return shouldInjectOpenAIHostedWebTools(ctx.model, openAISettings) ? injectOpenAIHostedWebTools(event.payload, openAISettings) : undefined;
    }

    return undefined;
  });

  const webFetchTool = defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch an http(s) URL as bounded text; no JS, clicks, auth, or visual inspection.",
      "Default mode='text' strips HTML boilerplate for lower token use; use mode='raw' only when exact markup matters.",
      "Use mode='metadata' for a compact title/headings/links view.",
      "Do not use for secrets, authenticated pages, forms, or side effects.",
    ].join("\n"),
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes to return after extraction, capped at 1 MB. Default 100000." })),
      mode: Type.Optional(Type.String({ description: "Output mode: text (default, token-efficient), raw (unprocessed response text), or metadata (title/headings/links)." })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const mode = Object.values(WebFetchMode).includes(params.mode as WebFetchMode) ? (params.mode as WebFetchMode) : WebFetchMode.Text;
        const result = await fetchWebText(params.url, { maxBytes: params.maxBytes, mode }, signal);
        const header = [
          `URL: ${result.url}`,
          `Status: ${result.status}`,
          `Content-Type: ${result.contentType ?? "unknown"}`,
          `Mode: ${result.mode}`,
          `Raw-Bytes: ${result.rawBytes}`,
          `Output-Bytes: ${result.outputBytes}`,
          result.truncated ? "Truncated: true" : "Truncated: false",
          "",
        ].join("\n");
        return { content: [txt(`${header}${result.text}`)], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [txt(`Could not fetch URL: ${message}`)], details: { text: "", url: params.url, status: 0, contentType: null, truncated: false, mode: WebFetchMode.Text, rawBytes: 0, outputBytes: 0, error: message }, isError: true };
      }
    },
    renderResult(result, { expanded }, theme) {
      const output = result.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (expanded) return new Text(output || "(no output)", 0, 0);

      const details = result.details as (WebFetchResult & { error?: string }) | undefined;
      const expandHint = theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
      if (!details) return new Text(`${theme.fg("muted", "Web fetch complete")}\n${expandHint}`, 0, 0);
      if (details.error) return new Text(`${theme.fg("error", `✗ ${details.error}`)}\n${expandHint}`, 0, 0);

      const contentType = details.contentType?.split(";", 1)[0] ?? "unknown";
      const statusColor = details.status >= 400 ? "warning" : "success";
      const icon = details.status >= 400 ? "⚠" : "✓";
      let summary = `${theme.fg(statusColor, icon)} ${theme.fg("muted", `HTTP ${details.status} · ${details.mode} · ${contentType} · ${formatSize(details.outputBytes)}`)}`;
      if (details.truncated) summary += ` ${theme.fg("warning", "[truncated]")}`;
      return new Text(`${summary}\n${expandHint}`, 0, 0);
    },
  });
  pi.registerTool(webFetchTool);
  registerPtcTools(pi, webFetchTool);

  const webContextTool = defineTool({
    name: "web_context",
    label: "Web Context",
    description: [
      "Return a concise text/API-first plan for gathering context from a website URL.",
      "Use before browser automation unless the user explicitly asks to browse, click, inspect, or visually verify.",
      "Prefer APIs, local repos, static fetches, sitemaps, feeds, llms.txt, and source docs first.",
      "Does not browse visually or click pages."
    ].join("\n"),
    parameters: Type.Object({
      url: Type.String({ description: "Website URL to gather context for." }),
      purpose: Type.Optional(Type.String({ description: "What information you need from the website." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const plan = buildContextPlan(params.url, params.purpose);
        return { content: [txt(plan)], details: { url: params.url, error: null as string | null } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [txt(`Could not build web context plan: ${message}`)], details: { url: params.url, error: message as string | null } };
      }
    },
  });
  pi.registerTool(webContextTool);
  registerPtcTools(pi, webContextTool);
}
