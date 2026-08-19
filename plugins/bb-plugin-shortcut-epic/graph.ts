export type NodeStatus = "ready" | "active" | "blocked" | "done" | "other";

export interface GraphNode {
  id: number;
  title: string;
  url: string | null;
  stateName: string;
  stateType: string;
  status: NodeStatus;
  isActive: boolean;
  blocked: boolean;
  owners: string[];
  position: number | null;
  externalBlockedBy: number[];
  updatedAt: string | null;
}

export interface GraphEdge {
  source: number;
  target: number;
}

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

export interface PositionedEdge extends GraphEdge {
  path: string;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  cyclicNodeIds: number[];
}

const NODE_WIDTH = 252;
const NODE_HEIGHT = 112;
const COLUMN_GAP = 104;
const ROW_GAP = 32;
const PADDING = 44;

function compareNodes(left: GraphNode, right: GraphNode) {
  const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
  const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
  return leftPosition - rightPosition || left.id - right.id;
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphLayout {
  if (nodes.length === 0) {
    return {
      width: 720,
      height: 360,
      nodes: [],
      edges: [],
      cyclicNodeIds: [],
    };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<number, Set<number>>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const usableEdges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const key = `${edge.source}:${edge.target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    usableEdges.push(edge);
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .sort(compareNodes)
    .map((node) => node.id);
  const processed = new Set<number>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    processed.add(id);
    for (const target of adjacency.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) {
        queue.push(target);
        queue.sort((left, right) => compareNodes(nodeById.get(left)!, nodeById.get(right)!));
      }
    }
  }

  const cyclicNodeIds = nodes
    .filter((node) => !processed.has(node.id))
    .sort(compareNodes)
    .map((node) => node.id);
  if (cyclicNodeIds.length > 0) {
    const trailingRank = Math.max(...ranks.values()) + 1;
    for (const id of cyclicNodeIds) ranks.set(id, trailingRank);
  }

  const columns = new Map<number, GraphNode[]>();
  for (const node of [...nodes].sort(compareNodes)) {
    const rank = ranks.get(node.id) ?? 0;
    if (!columns.has(rank)) columns.set(rank, []);
    columns.get(rank)!.push(node);
  }

  const orderedRanks = [...columns.keys()].sort((left, right) => left - right);
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length));
  const graphHeight =
    PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  const graphWidth =
    PADDING * 2 +
    orderedRanks.length * NODE_WIDTH +
    Math.max(0, orderedRanks.length - 1) * COLUMN_GAP;
  const positioned: PositionedNode[] = [];

  orderedRanks.forEach((rank, columnIndex) => {
    const column = columns.get(rank)!;
    const columnHeight =
      column.length * NODE_HEIGHT + Math.max(0, column.length - 1) * ROW_GAP;
    const startY = (graphHeight - columnHeight) / 2;
    column.forEach((node, rowIndex) => {
      positioned.push({
        ...node,
        x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: startY + rowIndex * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rank,
      });
    });
  });

  const positionedById = new Map(positioned.map((node) => [node.id, node]));
  const positionedEdges = usableEdges.map((edge) => {
    const source = positionedById.get(edge.source)!;
    const target = positionedById.get(edge.target)!;
    const startX = source.x + source.width;
    const startY = source.y + source.height / 2;
    const endX = target.x;
    const endY = target.y + target.height / 2;
    const bend = Math.max(36, Math.abs(endX - startX) / 2);
    return {
      ...edge,
      path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    };
  });

  return {
    width: Math.max(720, graphWidth),
    height: Math.max(360, graphHeight),
    nodes: positioned,
    edges: positionedEdges,
    cyclicNodeIds,
  };
}
