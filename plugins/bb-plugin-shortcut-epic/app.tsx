import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { GraphResponse, rpcContract } from "./server";
import { layoutGraph, type GraphNode, type NodeStatus } from "./graph.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<NodeStatus, string> = {
  ready: "Ready",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  other: "Other",
};

function statusClass(status: NodeStatus) {
  if (status === "ready") return "bg-success/10 text-success";
  if (status === "active") return "bg-primary/10 text-primary";
  if (status === "blocked") return "bg-destructive/10 text-destructive";
  if (status === "done") return "bg-muted text-muted-foreground";
  return "bg-secondary text-secondary-foreground";
}

function nodeClass(node: GraphNode) {
  return cn(
    "flex h-full flex-col rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    node.status === "ready" && "border-success/50",
    node.status === "blocked" && "border-destructive/50",
    node.isActive && "border-primary bg-primary/10 ring-2 ring-primary/45",
    node.status === "done" && "opacity-40",
  );
}

function StoryNode({ node }: { node: GraphNode }) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">sc-{node.id}</span>
        <div className="flex items-center gap-1">
          {node.blocked && node.isActive ? (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              Blocked
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              statusClass(node.status),
            )}
          >
            {STATUS_LABELS[node.status]}
          </span>
        </div>
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug">{node.title}</div>
      <div className="mt-auto flex min-w-0 items-center justify-between gap-2 pt-2 text-[11px] text-muted-foreground">
        <span className="truncate">{node.owners.join(", ") || node.stateName}</span>
        {node.externalBlockedBy.length > 0 ? (
          <span className="shrink-0 text-destructive" title={`External blockers: ${node.externalBlockedBy.join(", ")}`}>
            +{node.externalBlockedBy.length} external
          </span>
        ) : null}
      </div>
    </>
  );

  if (!node.url) return <div className={nodeClass(node)}>{content}</div>;
  return (
    <a
      className={nodeClass(node)}
      href={node.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open sc-${node.id}: ${node.title} in Shortcut`}
    >
      {content}
    </a>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: NodeStatus }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn("text-sm font-semibold", tone && statusClass(tone).split(" ")[1])}>
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function EpicGraph() {
  const { projectId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("loadGraph", { projectId });
      setData(result);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const layout = useMemo(
    () => layoutGraph(data?.nodes ?? [], data?.edges ?? []),
    [data?.edges, data?.nodes],
  );
  const nodeById = useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.id, node])),
    [data?.nodes],
  );

  if (!data && loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" aria-hidden="true" />
        Loading Shortcut Epic…
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-destructive/30 bg-destructive/5 p-5">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <Icon name="AlertTriangle" aria-hidden="true" />
            Epic graph unavailable
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => void load()}>
            <Icon name="RotateCcw" aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const warnings = [
    ...data.warnings,
    ...(layout.cyclicNodeIds.length > 0
      ? [`Dependency cycle detected among Stories ${layout.cyclicNodeIds.join(", ")}.`]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-4 py-3 md:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{data.epic.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">epic-{data.epic.id}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {data.project.name} · {data.configPath} · prerequisite → dependent
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Count label="ready" value={data.counts.ready} tone="ready" />
          <Count label="active" value={data.counts.active} tone="active" />
          <Count label="blocked" value={data.counts.blocked} tone="blocked" />
          <Count label="done" value={data.counts.done} tone="done" />
        </div>
        <div className="flex items-center gap-2">
          {data.epic.url ? (
            <Button asChild size="sm" variant="ghost">
              <a href={data.epic.url} target="_blank" rel="noreferrer">
                Open Epic
              </a>
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="outline"
            aria-label="Refresh Epic graph"
            disabled={loading}
            onClick={() => void load()}
          >
            <Icon name="RotateCcw" className={cn(loading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {error || warnings.length > 0 ? (
        <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground md:px-5">
          {error ? <span className="text-destructive">Refresh failed: {error}</span> : null}
          {error && warnings.length > 0 ? <span> · </span> : null}
          {warnings.join(" · ")}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {layout.nodes.length === 0 ? (
          <div className="flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground">
            This Epic has no Stories yet.
          </div>
        ) : (
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Dependency graph for ${data.epic.name}`}
            className="min-h-full min-w-full"
          >
            <defs>
              <marker
                id="shortcut-epic-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            <g aria-hidden="true">
              {layout.edges.map((edge) => {
                const source = nodeById.get(edge.source);
                const target = nodeById.get(edge.target);
                const active = source?.isActive || target?.isActive;
                const complete = source?.status === "done" && target?.status === "done";
                return (
                  <path
                    key={`${edge.source}:${edge.target}`}
                    d={edge.path}
                    className={cn(
                      "fill-none stroke-muted-foreground/45",
                      active && "stroke-primary/75",
                      complete && "opacity-30",
                    )}
                    strokeWidth={active ? 2.25 : 1.5}
                    markerEnd="url(#shortcut-epic-arrow)"
                  />
                );
              })}
            </g>
            {layout.nodes.map((node) => (
              <foreignObject
                key={node.id}
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
              >
                <div className="h-full p-1">
                  <StoryNode node={node} />
                </div>
              </foreignObject>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "epic-graph",
    title: "Shortcut Epic",
    icon: "Workflow",
    path: "epic",
    component: EpicGraph,
  });
});
