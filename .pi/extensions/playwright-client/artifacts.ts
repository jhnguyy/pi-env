import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export class BrowserArtifacts {
  constructor(private readonly rootDir: string) {}

  async screenshotPath(pageTitle: string | undefined): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify(pageTitle ?? "page");
    return join(this.rootDir, `${stamp}-${slug}.png`);
  }
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "page";
}
