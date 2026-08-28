import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export interface SessionTreeNode {
  readonly session: SessionInfo;
  readonly path: string;
  readonly children: SessionTreeNode[];
  latestActivity: number;
}

export interface VisibleSession {
  readonly session: SessionInfo;
  readonly path: string;
  readonly parentPath?: string;
  readonly depth: number;
  readonly isLast: boolean;
  readonly ancestorContinues: readonly boolean[];
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
}

function wouldCreateCycle(
  sessionPath: string,
  parentPath: string,
  sessions: ReadonlyMap<string, SessionInfo>,
): boolean {
  const seen = new Set<string>([sessionPath]);
  let currentPath: string | undefined = parentPath;
  while (currentPath) {
    if (seen.has(currentPath)) return true;
    seen.add(currentPath);
    currentPath = sessions.get(currentPath)?.parentSessionPath;
  }
  return false;
}

export function buildSessionTree(sessions: readonly SessionInfo[]): SessionTreeNode[] {
  const sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
  const nodesByPath = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    nodesByPath.set(session.path, {
      session,
      path: session.path,
      children: [],
      latestActivity: session.modified.getTime(),
    });
  }

  const roots: SessionTreeNode[] = [];
  for (const node of nodesByPath.values()) {
    const parentPath = node.session.parentSessionPath;
    const parent = parentPath ? nodesByPath.get(parentPath) : undefined;
    if (!parent || wouldCreateCycle(node.path, parent.path, sessionsByPath)) roots.push(node);
    else parent.children.push(node);
  }

  const updateLatestActivity = (node: SessionTreeNode): number => {
    node.latestActivity = node.children.reduce(
      (latest, child) => Math.max(latest, updateLatestActivity(child)),
      node.session.modified.getTime(),
    );
    return node.latestActivity;
  };
  const sortNodes = (nodes: SessionTreeNode[]): void => {
    nodes.sort(
      (left, right) =>
        right.latestActivity - left.latestActivity || left.path.localeCompare(right.path),
    );
    for (const node of nodes) sortNodes(node.children);
  };
  for (const root of roots) updateLatestActivity(root);
  sortNodes(roots);
  return roots;
}

export function flattenVisibleSessions(
  roots: readonly SessionTreeNode[],
  expandedPaths: ReadonlySet<string>,
): VisibleSession[] {
  const visible: VisibleSession[] = [];
  const walk = (
    node: SessionTreeNode,
    parentPath: string | undefined,
    depth: number,
    ancestorContinues: readonly boolean[],
    isLast: boolean,
  ): void => {
    const isExpanded = expandedPaths.has(node.path);
    visible.push({
      session: node.session,
      path: node.path,
      parentPath,
      depth,
      isLast,
      ancestorContinues,
      hasChildren: node.children.length > 0,
      isExpanded,
    });
    if (!isExpanded) return;

    node.children.forEach((child, index) => {
      walk(
        child,
        node.path,
        depth + 1,
        [...ancestorContinues, depth > 0 && !isLast],
        index === node.children.length - 1,
      );
    });
  };

  roots.forEach((root, index) => walk(root, undefined, 0, [], index === roots.length - 1));
  return visible;
}

export function searchSessions(sessions: readonly SessionInfo[], query: string): VisibleSession[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions
    .filter((session) => {
      const text = [session.name, session.firstMessage, session.cwd, session.path]
        .filter((value): value is string => Boolean(value))
        .join("\n")
        .toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort(
      (left, right) =>
        right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
    )
    .map((session) => ({
      session,
      path: session.path,
      depth: 0,
      isLast: true,
      ancestorContinues: [],
      hasChildren: false,
      isExpanded: false,
    }));
}
