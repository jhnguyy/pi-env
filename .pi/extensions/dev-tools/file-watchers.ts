import { existsSync, realpathSync, statSync } from "node:fs";
import type { AsyncSubscription } from "@parcel/watcher";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Minimatch } from "minimatch";

interface WatchPattern {
  root: string;
  logicalRoot: string;
  base: string;
  matcher: Minimatch;
  kind: number;
  shallow: boolean;
}

interface Subscription {
  watcher: AsyncSubscription;
  shallow: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGlob(glob: unknown, workspaceRoot: string): { root: string; pattern: string } {
  if (typeof glob === "string") {
    const pattern = isAbsolute(glob) ? glob : resolve(workspaceRoot, glob);
    const globStart = pattern.search(/[?*{[]/);
    const root = dirname(globStart < 0 ? pattern : pattern.slice(0, globStart) + "_");
    return { root, pattern: relative(root, pattern) };
  }
  if (!isRecord(glob) || typeof glob.pattern !== "string") throw new Error("Invalid watcher glob");
  const uri =
    typeof glob.baseUri === "string"
      ? glob.baseUri
      : isRecord(glob.baseUri)
        ? glob.baseUri.uri
        : undefined;
  if (typeof uri !== "string") throw new Error("Invalid watcher base URI");
  const root = fileURLToPath(uri);
  return { root, pattern: glob.pattern };
}

function parsePattern(value: unknown, workspaceRoot: string): WatchPattern {
  if (!isRecord(value)) throw new Error("Invalid file watcher");
  const kind = value.kind ?? 7;
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 1 || kind > 7) {
    throw new Error("Invalid file watcher kind");
  }
  const glob = parseGlob(value.globPattern, workspaceRoot);
  const pattern = glob.pattern.replaceAll("\\", "/");
  let root = glob.root;
  while (!existsSync(root) || !statSync(root).isDirectory()) {
    const parent = dirname(root);
    if (parent === root) throw new Error("File watcher has no existing directory");
    root = parent;
  }
  const physicalRoot = realpathSync(root);
  return {
    root: physicalRoot,
    logicalRoot: root,
    base: resolve(physicalRoot, relative(root, glob.root)),
    matcher: new Minimatch(pattern, {
      dot: true,
      nocase: process.platform === "win32",
    }),
    kind,
    shallow: root === glob.root && !pattern.includes("/") && !pattern.includes("**"),
  };
}

function matchesEvent(filter: WatchPattern, path: string, type: 1 | 2 | 3): boolean {
  const mask = type === 3 ? 4 : type;
  if ((filter.kind & mask) === 0) return false;
  if (filter.matcher.match(relative(filter.base, path).replaceAll("\\", "/"), type !== 2))
    return true;
  if (type === 2) return false;
  const suffix = relative(path, filter.base);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

function subscriptionRoots(registrations: Iterable<WatchPattern[]>): Map<string, boolean> {
  const roots = new Map<string, boolean>();
  for (const patterns of registrations) {
    for (const pattern of patterns) {
      roots.set(pattern.root, (roots.get(pattern.root) ?? true) && pattern.shallow);
    }
  }
  return roots;
}

/** Owns the subscriptions requested by one language-server process. */
export class FileWatchers {
  private readonly registrations = new Map<string, WatchPattern[]>();
  private readonly subscriptions = new Map<string, Subscription>();
  private pending = Promise.resolve();
  private closed = false;

  private enqueue(run: () => Promise<void>): Promise<void> {
    const task = this.pending.then(() => (this.closed ? undefined : run()));
    this.pending = task.catch(() => {});
    return task;
  }

  register(
    value: unknown,
    workspaceRoot: string,
    onChange: (path: string, type: 1 | 2 | 3) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    return this.enqueue(() => this.registerNow(value, workspaceRoot, onChange, onError));
  }

  private async registerNow(
    value: unknown,
    workspaceRoot: string,
    onChange: (path: string, type: 1 | 2 | 3) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (!Array.isArray(value)) throw new Error("Invalid watcher registrations");
    const parsed = value.map((registration: unknown) => {
      if (!isRecord(registration) || typeof registration.id !== "string") {
        throw new Error("Invalid watcher registration");
      }
      // Configuration is fixed at startup; no subscription is needed for its changes.
      if (registration.method === "workspace/didChangeConfiguration") {
        return { id: registration.id, patterns: [] };
      }
      const options = registration.registerOptions;
      if (
        registration.method !== "workspace/didChangeWatchedFiles" ||
        !isRecord(options) ||
        !Array.isArray(options.watchers)
      ) {
        throw new Error("Unsupported watcher registration");
      }
      return {
        id: registration.id,
        patterns: options.watchers.map((item: unknown) => parsePattern(item, workspaceRoot)),
      };
    });
    const combined = new Map(this.registrations);
    for (const { id, patterns } of parsed) combined.set(id, patterns);
    const roots = subscriptionRoots(combined.values());
    const created = new Map<string, Subscription>();
    try {
      for (const [root, shallow] of roots) {
        const existing = this.subscriptions.get(root);
        if (existing && (!existing.shallow || shallow)) continue;
        // Load the native addon only when the server requests a filesystem subscription.
        const { default: watcher } = await import("@parcel/watcher");
        // Exact-name watches must not scan unrelated ancestor subtrees.
        const subscription = await watcher.subscribe(
          root,
          (error, events) => {
            if (error) {
              onError(error);
              return;
            }
            for (const event of events) {
              if (event.path === root && event.type === "delete") {
                onError(new Error(`Watched directory was removed: ${root}`));
                return;
              }
              const type = event.type === "create" ? 1 : event.type === "update" ? 2 : 3;
              // Directory moves can emit only parent paths. Keep matching ancestor events.
              const paths = new Set<string>();
              for (const filters of this.registrations.values()) {
                for (const filter of filters) {
                  if (filter.root === root && matchesEvent(filter, event.path, type)) {
                    paths.add(resolve(filter.logicalRoot, relative(root, event.path)));
                  }
                }
              }
              for (const path of paths) onChange(path, type);
            }
          },
          shallow ? { ignore: [/[/\\\\]/] } : undefined,
        );
        created.set(root, { watcher: subscription, shallow });
      }
    } catch (error) {
      await this.unsubscribeAll(Array.from(created.values(), (item) => item.watcher)).catch(
        (cleanup) => {
          throw new AggregateError(
            [error, cleanup],
            "File watcher registration and cleanup failed",
            { cause: error },
          );
        },
      );
      throw error;
    }
    for (const { id, patterns } of parsed) this.registrations.set(id, patterns);
    const replaced: AsyncSubscription[] = [];
    for (const [root, subscription] of created) {
      const existing = this.subscriptions.get(root);
      if (existing) replaced.push(existing.watcher);
      this.subscriptions.set(root, subscription);
    }
    await this.unsubscribeAll(replaced);
    await this.closeUnused();
  }

  unregister(value: unknown): Promise<void> {
    return this.enqueue(() => this.unregisterNow(value));
  }

  private async unregisterNow(value: unknown): Promise<void> {
    if (
      !Array.isArray(value) ||
      !value.every((item) => isRecord(item) && typeof item.id === "string")
    ) {
      throw new Error("Invalid watcher unregistrations");
    }
    for (const { id } of value) this.registrations.delete(id);
    await this.closeUnused();
  }

  private async closeUnused(): Promise<void> {
    const roots = new Set(
      Array.from(this.registrations.values()).flatMap((patterns) =>
        patterns.map((pattern) => pattern.root),
      ),
    );
    const unused: AsyncSubscription[] = [];
    for (const [root, subscription] of this.subscriptions) {
      if (roots.has(root)) continue;
      unused.push(subscription.watcher);
      this.subscriptions.delete(root);
    }
    await this.unsubscribeAll(unused);
  }

  private async unsubscribeAll(subscriptions: Iterable<AsyncSubscription>): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(subscriptions, (item) => Promise.resolve().then(() => item.unsubscribe())),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "File watcher cleanup failed");
  }

  ready(): Promise<void> {
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
    const subscriptions = Array.from(this.subscriptions.values(), (item) => item.watcher);
    this.subscriptions.clear();
    this.registrations.clear();
    await this.unsubscribeAll(subscriptions);
  }
}
