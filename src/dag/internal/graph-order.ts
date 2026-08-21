interface DfsFrame {
  readonly node: number;
  next: number;
}

export interface GraphIndexedDependency {
  readonly index: number;
}

function finishOrder(adjacency: readonly (readonly number[])[]): number[] {
  const visited = new Uint8Array(adjacency.length);
  const order: number[] = [];
  for (let start = 0; start < adjacency.length; start++) {
    if (visited[start] === 1) continue;
    visited[start] = 1;
    const stack: DfsFrame[] = [{ node: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) break;
      const next = adjacency[frame.node]?.[frame.next++];
      if (next !== undefined && visited[next] === 0) {
        visited[next] = 1;
        stack.push({ node: next, next: 0 });
      } else if (next === undefined) {
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  return order;
}

function reversedAdjacency(adjacency: readonly (readonly number[])[]): number[][] {
  const reversed = Array.from({ length: adjacency.length }, (): number[] => []);
  for (let node = 0; node < adjacency.length; node++) {
    for (const dependency of adjacency[node] ?? []) reversed[dependency]?.push(node);
  }
  return reversed;
}

function collectComponent(
  start: number,
  adjacency: readonly (readonly number[])[],
  visited: Uint8Array,
): number[] {
  const component: number[] = [];
  const stack = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    component.push(node);
    for (const next of adjacency[node] ?? []) {
      if (visited[next] === 1) continue;
      visited[next] = 1;
      stack.push(next);
    }
  }
  return component;
}

export function cyclicNodeIndices(
  nodeCount: number,
  dependencies: readonly (readonly GraphIndexedDependency[])[],
): number[] {
  const adjacency = dependencies.map((items) => items.map((item) => item.index));
  const reversed = reversedAdjacency(adjacency);
  const visited = new Uint8Array(nodeCount);
  const cyclic = new Uint8Array(nodeCount);
  const selfLoops = new Uint8Array(nodeCount);
  for (let node = 0; node < adjacency.length; node++) {
    for (const dependency of adjacency[node] ?? []) {
      if (dependency === node) selfLoops[node] = 1;
    }
  }
  const order = finishOrder(adjacency);
  for (let cursor = order.length - 1; cursor >= 0; cursor--) {
    const start = order[cursor];
    if (start === undefined || visited[start] === 1) continue;
    const component = collectComponent(start, reversed, visited);
    if (component.length > 1 || selfLoops[start] === 1) {
      for (const node of component) cyclic[node] = 1;
    }
  }
  const indices: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (cyclic[index] === 1) indices.push(index);
  }
  return indices;
}

export function topologicalOrder(
  nodeCount: number,
  dependencies: readonly (readonly GraphIndexedDependency[])[],
): number[] {
  const indegree = dependencies.map((items) => items.length);
  const dependents = Array.from({ length: nodeCount }, (): number[] => []);
  for (let consumer = 0; consumer < nodeCount; consumer++) {
    for (const dependency of dependencies[consumer] ?? []) {
      dependents[dependency.index]?.push(consumer);
    }
  }
  const queue = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const producer = queue[cursor];
    if (producer === undefined) continue;
    for (const consumer of dependents[producer] ?? []) {
      const next = (indegree[consumer] ?? 0) - 1;
      indegree[consumer] = next;
      if (next === 0) queue.push(consumer);
    }
  }
  return queue;
}
