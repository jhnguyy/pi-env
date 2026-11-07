import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { slugify } from "../_shared/slug";

export class BrowserArtifacts {
  constructor(private readonly rootDir: string) {}

  async screenshotPath(pageTitle: string | undefined): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const stamp = stampForPath();
    const slug = slugify(pageTitle ?? "page", { fallback: "page" });
    return join(this.rootDir, `${stamp}-${slug}.png`);
  }

  async downloadPath(suggestedFilename: string | undefined): Promise<string> {
    const downloadDir = join(this.rootDir, "downloads");
    await mkdir(downloadDir, { recursive: true });
    const safeName = safeFilename(suggestedFilename ?? "download");
    return join(downloadDir, `${stampForPath()}-${safeName}`);
  }
}

function stampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() || "download";
  const match = /^(.*?)(\.[^.]+)?$/.exec(name);
  const stem = match?.[1] || "download";
  const ext = (match?.[2] ?? "").toLowerCase().replace(/[^.a-z0-9]+/g, "").slice(0, 20);
  return `${slugify(stem, { fallback: "page" })}${ext}`;
}
