import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { txt } from "../_shared/result";

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
