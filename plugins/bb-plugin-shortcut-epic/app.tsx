import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { GraphResponse, rpcContract } from "./server";
import { layoutGraph, type GraphNode, type NodeStatus } from "./graph.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 2;
const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];

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
      <div className="mt-1.5 break-words text-sm font-medium leading-snug">{node.title}</div>
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

function selectedEpicId(subPath: string) {
  if (!/^\d+$/.test(subPath)) return null;
  const value = Number(subPath);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function epicPreferenceKey(projectId: string | null) {
  return `shortcut-agent:last-epic:${projectId ?? "default"}`;
}

function readRememberedEpic(projectId: string | null) {
  try {
    return selectedEpicId(window.localStorage.getItem(epicPreferenceKey(projectId)) ?? "");
  } catch {
    return null;
  }
}

function rememberEpic(projectId: string | null, epicId: number) {
  try {
    window.localStorage.setItem(epicPreferenceKey(projectId), String(epicId));
  } catch {
    // The graph still works when browser storage is unavailable.
  }
}

function forgetEpic(projectId: string | null) {
  try {
    window.localStorage.removeItem(epicPreferenceKey(projectId));
  } catch {
    // The graph still works when browser storage is unavailable.
  }
}

function EpicPicker({
  value,
  loading,
  canUseDefault,
  selectionError,
  onChange,
  onSubmit,
  onUseDefault,
}: {
  value: string;
  loading: boolean;
  canUseDefault: boolean;
  selectionError: string | null;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUseDefault: () => void;
}) {
  return (
    <div>
      <form className="flex items-center gap-2" onSubmit={onSubmit}>
        <label htmlFor="shortcut-agent-epic-id" className="text-xs text-muted-foreground">
          Epic ID
        </label>
        <input
          id="shortcut-agent-epic-id"
          className="h-8 w-28 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="number"
          min="1"
          step="1"
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={loading}>
          Load
        </Button>
        {canUseDefault ? (
          <Button type="button" size="sm" variant="ghost" onClick={onUseDefault}>
            Use default
          </Button>
        ) : null}
      </form>
      {selectionError ? (
        <div className="mt-1 text-xs text-destructive">{selectionError}</div>
      ) : null}
    </div>
  );
}

function EpicGraph({ subPath }: { subPath: string }) {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const routeEpicId = useMemo(() => selectedEpicId(subPath), [subPath]);
  const [rememberedEpicId, setRememberedEpicId] = useState(() =>
    routeEpicId === null ? readRememberedEpic(projectId) : null,
  );
  const requestedEpicId = routeEpicId ?? rememberedEpicId;
  const [epicInput, setEpicInput] = useState(() =>
    requestedEpicId === null ? "" : String(requestedEpicId),
  );
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const graphScrollerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("loadGraph", {
        projectId,
        epicId: requestedEpicId,
      });
      setData(result);
      setEpicInput(String(result.epic.id));
      rememberEpic(projectId, result.epic.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, requestedEpicId, rpc]);

  useEffect(() => {
    if (routeEpicId !== null) {
      setRememberedEpicId(null);
      setEpicInput(String(routeEpicId));
      return;
    }
    const remembered = readRememberedEpic(projectId);
    setRememberedEpicId(remembered);
    if (remembered !== null) setEpicInput(String(remembered));
  }, [projectId, routeEpicId]);

  useEffect(() => {
    if (requestedEpicId) setEpicInput(String(requestedEpicId));
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const chooseEpic = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = Number(epicInput);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setSelectionError("Enter a positive Epic ID.");
      return;
    }
    setSelectionError(null);
    rememberEpic(projectId, id);
    navigate.toPluginPanel("epic", { subPath: String(id) });
  };

  const useDefaultEpic = () => {
    setSelectionError(null);
    forgetEpic(projectId);
    setRememberedEpicId(null);
    navigate.toPluginPanel("epic", { subPath: "" });
  };

  const picker = (
    <EpicPicker
      value={epicInput}
      loading={loading}
      canUseDefault={requestedEpicId !== null}
      selectionError={selectionError}
      onChange={setEpicInput}
      onSubmit={chooseEpic}
      onUseDefault={useDefaultEpic}
    />
  );

  const visibleNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => showCompleted || node.status !== "done"),
    [data?.nodes, showCompleted],
  );
  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    return (data?.edges ?? []).filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
  }, [data?.edges, visibleNodes]);
  const layout = useMemo(
    () => layoutGraph(visibleNodes, visibleEdges),
    [visibleEdges, visibleNodes],
  );
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );

  const applyZoom = (nextZoom: number, resetScroll = false) => {
    const boundedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const scroller = graphScrollerRef.current;
    const center = scroller
      ? {
          x: (scroller.scrollLeft + scroller.clientWidth / 2) / zoom,
          y: (scroller.scrollTop + scroller.clientHeight / 2) / zoom,
        }
      : null;
    setZoom(boundedZoom);
    if (!scroller) return;
    window.requestAnimationFrame(() => {
      if (typeof scroller.scrollTo !== "function") return;
      if (resetScroll) {
        scroller.scrollTo({ left: 0, top: 0 });
      } else if (center) {
        scroller.scrollTo({
          left: Math.max(0, center.x * boundedZoom - scroller.clientWidth / 2),
          top: Math.max(0, center.y * boundedZoom - scroller.clientHeight / 2),
        });
      }
    });
  };

  const zoomOut = () => {
    const next = [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
    applyZoom(next ?? MIN_ZOOM);
  };

  const zoomIn = () => {
    const next = ZOOM_STEPS.find((step) => step > zoom + 0.001);
    applyZoom(next ?? MAX_ZOOM);
  };

  const fitGraph = () => {
    const scroller = graphScrollerRef.current;
    if (!scroller || scroller.clientWidth <= 0 || scroller.clientHeight <= 0) return;
    const availableWidth = Math.max(1, scroller.clientWidth - 24);
    const availableHeight = Math.max(1, scroller.clientHeight - 24);
    applyZoom(
      Math.min(1, availableWidth / layout.width, availableHeight / layout.height),
      true,
    );
  };

  if (!data && loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" aria-hidden="true" />
        Loading Shortcut Agent…
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
          <div className="mt-4">{picker}</div>
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
          <div className="mt-2">{picker}</div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Count label="ready" value={data.counts.ready} tone="ready" />
          <Count label="active" value={data.counts.active} tone="active" />
          <Count label="blocked" value={data.counts.blocked} tone="blocked" />
          <Count label="done" value={data.counts.done} tone="done" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center rounded-md border border-border bg-background p-0.5"
            role="group"
            aria-label="Graph zoom"
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
            >
              <span aria-hidden="true">−</span>
            </Button>
            <span
              className="min-w-12 px-1 text-center font-mono text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
            >
              <span aria-hidden="true">+</span>
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={fitGraph}>
              Fit
            </Button>
          </div>
          {data.counts.done > 0 ? (
            <Button
              size="sm"
              variant={showCompleted ? "secondary" : "outline"}
              aria-pressed={showCompleted}
              onClick={() => setShowCompleted((current) => !current)}
            >
              {showCompleted
                ? "Hide completed"
                : `Show completed (${data.counts.done})`}
            </Button>
          ) : null}
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

      <div ref={graphScrollerRef} className="min-h-0 flex-1 overflow-auto">
        {layout.nodes.length === 0 ? (
          <div className="flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground">
            {data.nodes.length > 0 && data.counts.done === data.nodes.length
              ? `All ${data.counts.done} Stories are complete.`
              : "This Epic has no Stories yet."}
          </div>
        ) : (
          <svg
            width={Math.max(1, Math.round(layout.width * zoom))}
            height={Math.max(1, Math.round(layout.height * zoom))}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Dependency graph for ${data.epic.name}`}
            className="mx-auto block"
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
    title: "Shortcut Agent",
    icon: "Workflow",
    path: "epic",
    component: EpicGraph,
  });
});
