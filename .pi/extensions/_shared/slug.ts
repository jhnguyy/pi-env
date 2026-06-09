export interface SlugOptions {
  maxLength?: number;
  fallback?: string;
}

export function slugify(value: string, options: SlugOptions = {}): string {
  const maxLength = options.maxLength ?? 60;
  const fallback = options.fallback ?? "item";
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (maxLength > 0 ? slug.slice(0, maxLength) : slug) || fallback;
}
