import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphNode } from "./graph.js";

function node(id: number, position = id): GraphNode {
  return {
    id,
    title: `Story ${id}`,
    url: null,
    stateName: "Ready",
    stateType: "unstarted",
    status: "ready",
    isActive: false,
    blocked: false,
    owners: [],
    position,
    externalBlockedBy: [],
    updatedAt: null,
  };
}

describe("layoutGraph", () => {
  it("places prerequisites to the left of their dependents", () => {
    const layout = layoutGraph(
      [node(1), node(2), node(3)],
      [
        { source: 1, target: 2 },
        { source: 2, target: 3 },
      ],
    );
    const byId = new Map(layout.nodes.map((item) => [item.id, item]));
    expect(byId.get(1)!.x).toBeLessThan(byId.get(2)!.x);
    expect(byId.get(2)!.x).toBeLessThan(byId.get(3)!.x);
    expect(layout.edges).toHaveLength(2);
    expect(layout.cyclicNodeIds).toEqual([]);
  });

  it("keeps ordering deterministic within a dependency rank", () => {
    const layout = layoutGraph([node(8, 20), node(7, 10), node(9, 30)], []);
    expect(layout.nodes.map((item) => item.id)).toEqual([7, 8, 9]);
    expect(layout.nodes.map((item) => item.y)).toEqual(
      [...layout.nodes.map((item) => item.y)].sort((left, right) => left - right),
    );
  });

  it("surfaces cycles without hanging the layout", () => {
    const layout = layoutGraph(
      [node(1), node(2)],
      [
        { source: 1, target: 2 },
        { source: 2, target: 1 },
      ],
    );
    expect(layout.cyclicNodeIds).toEqual([1, 2]);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });

  it("ignores duplicate and out-of-scope edges", () => {
    const layout = layoutGraph(
      [node(1), node(2)],
      [
        { source: 1, target: 2 },
        { source: 1, target: 2 },
        { source: 2, target: 99 },
      ],
    );
    expect(layout.edges).toHaveLength(1);
  });
});
