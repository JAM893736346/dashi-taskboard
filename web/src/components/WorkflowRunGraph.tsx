import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { WorkflowRunSnapshot } from "../types";
import { WorkflowRuntimeNode, type WorkflowRuntimeFlowNode } from "./WorkflowRuntimeNode";
import "./workflow-runtime.css";

const NODE_TYPES = { workflowRuntime: WorkflowRuntimeNode } satisfies NodeTypes;
const FORMAL_WIDTH = 300;
const FORMAL_HEIGHT = 166;
const SUBAGENT_HEIGHT = 76;
const LEVEL_GAP = 88;
const ROW_GAP = 54;

interface WorkflowRunGraphProps {
  snapshot: WorkflowRunSnapshot;
  selectedNodeRunId: string | null;
  onSelectNode: (nodeRunId: string, tab?: "subagents") => void;
}

function layoutLevels(snapshot: WorkflowRunSnapshot) {
  const definitions = snapshot.effectiveGraph.nodes;
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const pendingDependencies = new Map(definitions.map((definition) => [definition.id, definition.dependsOn.length]));
  const successors = new Map(definitions.map((definition) => [definition.id, [] as string[]]));
  for (const definition of definitions) {
    for (const dependency of definition.dependsOn) {
      successors.get(dependency.nodeId)?.push(definition.id);
    }
  }
  const levels = new Map<string, number>();
  const ready = definitions
    .filter((definition) => definition.dependsOn.length === 0)
    .map((definition) => definition.id)
    .sort();
  while (ready.length > 0) {
    const id = ready.shift()!;
    const definition = definitionsById.get(id)!;
    const level = definition.dependsOn.reduce(
      (maximum, dependency) => Math.max(maximum, (levels.get(dependency.nodeId) ?? -1) + 1),
      0,
    );
    levels.set(id, level);
    for (const successorId of successors.get(id) ?? []) {
      const remaining = (pendingDependencies.get(successorId) ?? 1) - 1;
      pendingDependencies.set(successorId, remaining);
      if (remaining === 0) {
        ready.push(successorId);
        ready.sort();
      }
    }
  }
  return levels;
}

export function WorkflowRunGraph({ snapshot, selectedNodeRunId, onSelectNode }: WorkflowRunGraphProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const { nodes, edges } = useMemo(() => {
    const levels = layoutLevels(snapshot);
    const levelNextY = new Map<number, number>();
    const nodeByDefinitionId = new Map(snapshot.nodes.map((node) => [node.definitionId, node]));
    const attempts = new Map(snapshot.attempts.map((attempt) => [attempt.id, attempt]));
    const runtimeNodes: WorkflowRuntimeFlowNode[] = [];

    for (const definition of snapshot.effectiveGraph.nodes) {
      const node = nodeByDefinitionId.get(definition.id);
      if (!node) continue;
      const level = levels.get(definition.id) ?? 0;
      const subagents = snapshot.subagents.filter((subagent) => subagent.nodeRunId === node.id);
      const expanded = expandedIds.has(node.id);
      const height = FORMAL_HEIGHT + (expanded ? subagents.length * SUBAGENT_HEIGHT : 0);
      const y = levelNextY.get(level) ?? 0;
      levelNextY.set(level, y + height + ROW_GAP);
      runtimeNodes.push({
        id: node.id,
        type: "workflowRuntime",
        position: { x: level * (FORMAL_WIDTH + LEVEL_GAP), y },
        style: { width: FORMAL_WIDTH, height },
        selected: node.id === selectedNodeRunId,
        data: {
          kind: "formal",
          definition,
          node,
          attempt: node.activeAttemptId ? attempts.get(node.activeAttemptId) ?? null : null,
          model: typeof node.config.model === "string" ? node.config.model : snapshot.effectiveGraph.defaults.model,
          effort: typeof node.config.effort === "string" ? node.config.effort : snapshot.effectiveGraph.defaults.effort,
          inboxCount: snapshot.inbox.filter((message) => (
            message.targetNodeRunId === node.id
            && (message.status === "pending" || message.status === "fallback_queued")
          )).length,
          subagents,
          expanded,
          onToggleSubagents: () => setExpandedIds((current) => {
            const next = new Set(current);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          }),
        },
      });
      if (expanded) {
        subagents.forEach((subagent, index) => runtimeNodes.push({
          id: `subagent:${subagent.id}`,
          type: "workflowRuntime",
          parentId: node.id,
          extent: "parent",
          draggable: false,
          selectable: true,
          position: { x: 10, y: FORMAL_HEIGHT + index * SUBAGENT_HEIGHT },
          style: { width: FORMAL_WIDTH - 20, height: SUBAGENT_HEIGHT - 8 },
          data: { kind: "subagent", subagent },
        }));
      }
    }

    const runtimeEdges: Edge[] = [];
    for (const definition of snapshot.effectiveGraph.nodes) {
      const target = nodeByDefinitionId.get(definition.id);
      if (!target) continue;
      definition.dependsOn.forEach((dependency) => {
        const source = nodeByDefinitionId.get(dependency.nodeId);
        if (!source) return;
        runtimeEdges.push({
          id: `${source.id}->${target.id}`,
          source: source.id,
          target: target.id,
          label: dependency.outcome,
          className: dependency.outcome ? "workflow-runtime-condition-edge" : undefined,
          labelStyle: { fill: "var(--text-tertiary)", fontSize: 10 },
        });
      });
    }
    return { nodes: runtimeNodes, edges: runtimeEdges };
  }, [expandedIds, selectedNodeRunId, snapshot]);

  return (
    <div className="workflow-runtime-canvas" aria-label="Workflow 运行图">
      <ReactFlow<WorkflowRuntimeFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        panOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.4}
        maxZoom={1.2}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        onNodeClick={(_, node) => {
          if (node.data.kind === "subagent" && node.data.subagent) onSelectNode(node.data.subagent.nodeRunId, "subagents");
          else onSelectNode(node.id);
        }}
      >
        <Background color="var(--border-strong)" gap={22} size={0.7} variant={BackgroundVariant.Dots} />
        <Controls className="workflow-runtime-controls" position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
