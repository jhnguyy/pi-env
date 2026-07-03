import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { txt } from "../_shared/result";
import { injectAnthropicHostedWebTools, loadAnthropicWebToolSettings, shouldInjectAnthropicHostedWebTools } from "./anthropic-tools";

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

export async function fetchWebText(rawUrl: string, maxBytes = 100_000, signal?: AbortSignal): Promise<{ text: string; url: string; status: number; contentType: string | null; truncated: boolean }> {
  const url = parseWebUrl(rawUrl);
  const response = await fetch(url, {
    redirect: "follow",
    signal,
    headers: { accept: "text/html, text/plain, application/json, application/xml, text/*;q=0.9, */*;q=0.1" },
  });
  const contentType = response.headers.get("content-type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = Math.max(1, Math.min(maxBytes, 1_000_000));
  const truncated = bytes.byteLength > limit;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, limit));
  return { text, url: response.url, status: response.status, contentType, truncated };
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
  pi.on("before_provider_request", (event, ctx) => {
    const settings = loadAnthropicWebToolSettings(ctx.cwd);
    if (!shouldInjectAnthropicHostedWebTools(ctx.model, settings)) return undefined;
    return injectAnthropicHostedWebTools(event.payload, settings);
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch an http(s) URL as text without browser automation.",
      "Use web_fetch for direct URL retrieval when a text/API/static fetch is sufficient.",
      "This tool does not execute page JavaScript, click, authenticate, or visually inspect pages.",
      "For direct Anthropic models, hosted web_search is attached at the provider layer.",
    ].join("\n"),
    promptSnippet: "Fetch an http(s) URL as bounded text; no browser, JavaScript execution, clicks, auth, or visual inspection.",
    promptGuidelines: [
      "Use web_fetch for direct URL retrieval before considering browser automation.",
      "Do not use web_fetch for secrets, authenticated pages, forms, or actions with side effects.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL to fetch." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes to return, capped at 1 MB. Default 100000." })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await fetchWebText(params.url, params.maxBytes, signal);
        const header = [
          `URL: ${result.url}`,
          `Status: ${result.status}`,
          `Content-Type: ${result.contentType ?? "unknown"}`,
          result.truncated ? "Truncated: true" : "Truncated: false",
          "",
        ].join("\n");
        return { content: [txt(`${header}${result.text}`)], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [txt(`Could not fetch URL: ${message}`)], details: { text: "", url: params.url, status: 0, contentType: null, truncated: false, error: message }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "web_context",
    label: "Web Context",
    description: [
      "Map a website URL to the preferred programmatic context-gathering strategy.",
      "Use this before considering the browser tool when a task mentions a website.",
      "Policy: do not use the browser tool for websites unless the user explicitly asks you to browse, inspect, click through, or visually verify the site.",
      "If browser use still appears necessary after text/API-first context gathering, ask the user for explicit permission before calling the browser tool.",
      "Prefer existing scripts, APIs, repo docs, cached notes, static fetches, sitemaps, feeds, llms.txt, and other text-first sources before browser automation.",
      "The tool returns known site-specific adapters when available and a generic text/API-first plan otherwise.",
      "It does not browse visually or click through pages.",
      "On direct Anthropic models, pi-env can attach Anthropic-hosted web_search to provider requests; set webContext.anthropicHostedTools.enabled=false to disable."
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
}
