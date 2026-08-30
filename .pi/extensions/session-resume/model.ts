export interface ResumeSession {
  readonly path: string;
  readonly parentPath?: string;
  readonly cwd: string;
  readonly title: string;
  readonly searchText: string;
  readonly modifiedAt: number;
}

export interface SessionTreeNode {
  readonly session: ResumeSession;
  readonly children: SessionTreeNode[];
  latestActivity: number;
}

export interface VisibleSession {
  readonly session: ResumeSession;
  readonly parentPath?: string;
  readonly depth: number;
  readonly isLast: boolean;
  readonly ancestorContinues: readonly boolean[];
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
}

function hasParentCycle(
  sessionPath: string,
  parentPath: string,
  sessionsByPath: ReadonlyMap<string, ResumeSession>,
): boolean {
  const seen = new Set([sessionPath]);
  let path: string | undefined = parentPath;
  while (path) {
    if (seen.has(path)) return true;
    seen.add(path);
    path = sessionsByPath.get(path)?.parentPath;
  }
  return false;
}

export function buildSessionTree(sessions: readonly ResumeSession[]): SessionTreeNode[] {
  const sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
  const nodesByPath = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    nodesByPath.set(session.path, {
      session,
      children: [],
      latestActivity: session.modifiedAt,
    });
  }

  const roots: SessionTreeNode[] = [];
  for (const node of nodesByPath.values()) {
    const parentPath = node.session.parentPath;
    const parent = parentPath ? nodesByPath.get(parentPath) : undefined;
    if (parent && !hasParentCycle(node.session.path, parent.session.path, sessionsByPath)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const updateLatestActivity = (node: SessionTreeNode): number => {
    node.latestActivity = node.children.reduce(
      (latest, child) => Math.max(latest, updateLatestActivity(child)),
      node.session.modifiedAt,
    );
    return node.latestActivity;
  };
  const sortNodes = (nodes: SessionTreeNode[]): void => {
    nodes.sort(
      (left, right) =>
        right.latestActivity - left.latestActivity ||
        left.session.path.localeCompare(right.session.path),
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
    const isExpanded = expandedPaths.has(node.session.path);
    visible.push({
      session: node.session,
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
        node.session.path,
        depth + 1,
        [...ancestorContinues, depth > 0 && !isLast],
        index === node.children.length - 1,
      );
    });
  };

  roots.forEach((root, index) => walk(root, undefined, 0, [], index === roots.length - 1));
  return visible;
}

export function searchSessions(
  sessions: readonly ResumeSession[],
  query: string,
): VisibleSession[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions
    .filter((session) => terms.every((term) => session.searchText.includes(term)))
    .sort(
      (left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path),
    )
    .map((session) => ({
      session,
      depth: 0,
      isLast: true,
      ancestorContinues: [],
      hasChildren: false,
      isExpanded: false,
    }));
}
