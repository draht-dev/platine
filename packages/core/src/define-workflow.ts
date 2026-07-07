// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/define-workflow — typed DAG builder.
 *
 * CRITICAL DESIGN NOTES (locked per adversarial verification — Appendix A.1):
 *
 * 1. NO Pipe<Out,In>-as-return-type: WiringError-as-return-value is inert
 *    (errors one hop later at wrong line). Use single-call-site mapper functions.
 * 2. NO variadic chain(): a mid-chain mis-wire collapses Fold to `never` → silent tsc.
 *    A linear chain is a sequence of localized b.node(def, from, mapper) edges.
 * 3. Fan-out brand is NEGATIVE on NodeHandle (__fanout?: never), NOT positive on
 *    FanoutHandle. A positive-only brand leaks: FanoutHandle is assignable to
 *    NodeHandle. Only the negative brand on the target causes tsc to reject piping
 *    a fan-out branch (probe5).
 * 4. Merge collisions surface via a required downstream read of the never-typed
 *    intersection key, NOT by returning an inert WiringError.
 * 5. In AND Out inferred at ONE call site. split factory shape loses Out to `unknown`
 *    (probe8). Both generics must be at the same call.
 * 6. CI fixture suite in fixtures/miswire/ asserts each mis-wire errors at the
 *    expected line.
 */

import type { Schema, Infer, ToolDef } from "./define-tool.js";
import type { AgentDef, AgentRef } from "./define-agent.js";
// compile.ts only imports TYPES from this file, so the circular reference
// is type-only — no runtime cycle. The static import works correctly.
import { compileWorkflow as _compileWorkflow } from "./compile.js";

// ---------------------------------------------------------------------------
// Re-export shared types so consumers only need to import define-workflow
// ---------------------------------------------------------------------------
export type { Schema, Infer };

// ---------------------------------------------------------------------------
// TriggerConfig — matches the TriggerZ discriminated union in the Manifest.
// ---------------------------------------------------------------------------

export type TriggerConfig =
  | {
      type: "schedule";
      schedule: "hourly" | "daily" | "weekly";
      time?: string;
      dayOfWeek?: number;
      timezone?: string;
    }
  | {
      type: "event";
      eventType: string;
      filters?: Array<{
        field: string;
        operator: "eq" | "neq" | "contains" | "regex" | "gt" | "gte" | "lt" | "lte";
        value: string;
      }>;
    }
  | {
      type: "webhook";
      channelRef: string;
    }
  | {
      type: "manual";
    };

// ---------------------------------------------------------------------------
// NodeHandle / FanoutHandle — the load-bearing brand shapes.
//
// MUST-FIX #3: The NEGATIVE brand (__fanout?: never) on NodeHandle is what
// causes tsc to REJECT assigning a FanoutHandle (where __fanout: true) to a
// NodeHandle parameter. A positive-only brand on FanoutHandle leaks because
// structural assignability allows extra properties.
// ---------------------------------------------------------------------------

/**
 * A handle to a workflow node that produces a value of type `Out`.
 * The `__fanout?: never` field is a NEGATIVE brand: it structurally excludes
 * FanoutHandle (which has `__fanout: true`) from being passed to any method
 * that expects NodeHandle.
 */
export interface NodeHandle<Out> {
  readonly id: string;
  readonly __out?: Out;
  /** NEGATIVE brand: prevents FanoutHandle from being passed as NodeHandle. */
  readonly __fanout?: never;
}

/**
 * A handle produced by b.split(). Can ONLY be consumed by b.fanout().
 * It is structurally incompatible with NodeHandle because __fanout: true
 * conflicts with NodeHandle's __fanout?: never.
 */
export interface FanoutHandle<Elem> {
  readonly id: string;
  readonly __elem?: Elem;
  readonly __fanout: true;
}

// ---------------------------------------------------------------------------
// Internal node records — what the builder records at runtime.
// ---------------------------------------------------------------------------

/** Recorded node kinds tracked by the builder. */
export type RecordedNodeKind =
  | "trigger"
  | "tool"
  | "agent"
  | "transform"
  | "split"
  | "fanout"
  | "merge"
  | "output"
  | "unsafe";

/** A single recorded node in the workflow DAG. */
export interface RecordedNode {
  readonly id: string;
  readonly kind: RecordedNodeKind;
  /** The ToolDef or AgentDef this node wraps, if any. */
  readonly def?: ToolDef<Schema, Schema> | AgentDef<Schema, Schema>;
  /** Whether this node requires approval (tool nodes only). */
  readonly requiresApproval?: boolean;
  /** The trigger config (trigger nodes only). */
  readonly triggerConfig?: TriggerConfig & { payload?: Schema };
  /** The mapper function (tool/agent nodes). Recorded for the compiler's Proxy run. */
  readonly mapper?: (out: unknown) => unknown;
  /** The pure transform function (transform nodes). */
  readonly fn?: (out: unknown) => unknown;
  /** The fanout body function (fanout nodes). Retained for introspection —
   * compile.ts no longer invokes it; the sub-recording in `fanout()` already
   * captured the resulting nodes/edges into subNodeIds below. */
  readonly fanoutBody?: (item: NodeHandle<unknown>) => NodeHandle<unknown>;
  /**
   * The ids of nodes recorded while eagerly invoking the fanout body against
   * THIS builder (fanout nodes only), in recorded (topological) order. These
   * ids are already present in the enclosing WorkflowDef's `nodes` array —
   * this field is just the "which of wf.nodes belong to THIS fanout's
   * elementSubgraph" index that compile.ts reads to emit `elementSubgraph`.
   */
  readonly subNodeIds?: readonly string[];
  /**
   * SHOULD-FIX 4: the id of the node the fanout body ACTUALLY RETURNED
   * (fanout nodes only) — i.e. `body(itemHandle)`'s return value, captured in
   * `fanout()`. This is the sub-node whose per-item output the executor must
   * collect as the fanout's result. It is NOT necessarily the last id in
   * subNodeIds / the last-topo-order member: a body may record additional
   * nodes (e.g. an audit/logging node) AFTER the handle it returns.
   */
  readonly terminalSubNodeId?: string;
  /** Concurrency for fanout nodes. */
  readonly concurrency?: number;
  /** The merge source IDs (merge nodes). */
  readonly mergeSourceIds?: readonly string[];
}

/** A single recorded directed edge in the workflow DAG. */
export interface RecordedEdge {
  readonly edgeId: string;
  readonly source: string;
  readonly target: string;
}

// ---------------------------------------------------------------------------
// Builder interface — MUST-FIX #1/#2/#3/#4/#5 all manifest here.
// ---------------------------------------------------------------------------

/**
 * The workflow builder. All methods return typed NodeHandle values.
 * Edges are localized — each `b.node(...)` call records one edge at exactly
 * one call site (must-fix #2: no variadic chain sugar).
 */
export interface Builder {
  /**
   * Declare the workflow trigger and its payload schema.
   * Returns a NodeHandle typed to the INFERRED payload type.
   *
   * @example
   * const t = b.trigger({ type: "event", eventType: "ticket.created",
   *                        payload: z.object({ body: z.string() }) });
   * // t: NodeHandle<{ body: string }>
   */
  trigger<P extends Schema>(
    cfg: TriggerConfig & { payload: P }
  ): NodeHandle<Infer<P>>;

  /**
   * Wire a tool or agent node, inferring BOTH In AND Out at a single call site.
   * (must-fix #5: split factory shapes lose Out to `unknown`.)
   *
   * The mapper's parameter type = the upstream node's output (TS2339/TS2322
   * errors appear at the mapper body for bad field accesses).
   * The mapper's return type is constrained to Infer<I> (TS2741/TS2353 errors
   * appear at the return for missing/extra fields).
   *
   * @example
   * const c = b.node(classify, t, (p) => ({ body: p.body }));
   * const t2 = b.node(createTicket, c, (out) => ({
   *   subject: out.summary,
   *   priority: out.severity,
   *   // priority: out.nope,  // ← TS2339 HERE, exact line
   * }));
   */
  node<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O> | AgentRef<I, O>,
    from: NodeHandle<Up>,
    mapper: (out: Up) => Infer<I>,
    opts?: { requiresApproval?: boolean }
  ): NodeHandle<Infer<O>>;

  /**
   * Pure synchronous transform: both Up and Out are inferred at one call site.
   *
   * @example
   * const upper = b.transform(t, (p) => ({ body: p.body.toUpperCase() }));
   */
  transform<Up, Out>(
    from: NodeHandle<Up>,
    fn: (out: Up) => Out
  ): NodeHandle<Out>;

  /**
   * Split an array-typed node into a FanoutHandle for element-wise processing.
   * The returned FanoutHandle is structurally incompatible with NodeHandle
   * (because NodeHandle has `__fanout?: never` while FanoutHandle has `__fanout: true`),
   * so any attempt to pass it to a non-fanout method is a compile-time error.
   *
   * @example
   * const items = b.transform(t, p => p.items);
   * const fh = b.split(items);
   * const processed = b.fanout(fh, (item) => b.node(processTool, item, x => x));
   */
  split<Up extends readonly unknown[]>(
    from: NodeHandle<Up>
  ): FanoutHandle<Up[number]>;

  /**
   * Fan-out: process each element of a FanoutHandle concurrently.
   * This is the ONLY method that consumes a FanoutHandle.
   * Returns a NodeHandle wrapping the collected results as an array.
   */
  fanout<Elem, R>(
    from: FanoutHandle<Elem>,
    body: (item: NodeHandle<Elem>) => NodeHandle<R>,
    opts?: { concurrency?: number }
  ): NodeHandle<R[]>;

  /**
   * Merge two upstream NodeHandles into a single handle typed as A & B.
   * (must-fix #4): Collisions surface when a REQUIRED downstream mapper field
   * reads a never-typed key in the intersection — this produces a native
   * TS2345/TS2322 at the read site. Do NOT use an inert WiringError return.
   *
   * @example
   * const m = b.merge(nodeA, nodeB);
   * // If A = { x: string } and B = { x: number }, then A & B = { x: never }.
   * // A downstream mapper reading `m => m.x` would fail only if the field is
   * // typed as the conflicting intersection — required reads surface the error.
   */
  merge<A, B>(a: NodeHandle<A>, b: NodeHandle<B>): NodeHandle<A & B>;

  /**
   * Mark a handle as the workflow output. Returns the same handle unchanged.
   * Primarily used to signal to the compiler which node is the terminal node.
   */
  output<T>(h: NodeHandle<T>): NodeHandle<T>;

  /**
   * Escape hatch: drops the compile-time input type check for the mapper.
   * The runtime parse still validates the actual value against the tool's
   * inputSchema — this only bypasses the static type constraint.
   *
   * Use when a mapper cannot be expressed as a pure type-safe function
   * (e.g., it involves conditional logic over union types).
   */
  unsafeNode<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O>,
    from: NodeHandle<Up>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapper: (out: Up) => any
  ): NodeHandle<Infer<O>>;
}

// ---------------------------------------------------------------------------
// WorkflowDef — the artifact produced by defineWorkflow
// ---------------------------------------------------------------------------

/** The compiled workflow definition. Exposes `.compile()` to produce a Manifest. */
export interface WorkflowDef {
  /** The recorded nodes in topological order. */
  readonly nodes: ReadonlyArray<RecordedNode>;
  /** The recorded edges. */
  readonly edges: ReadonlyArray<RecordedEdge>;
  /** The id of the output (terminal) node. */
  readonly outputNodeId: string;
  /**
   * Compile this workflow into a Manifest.
   * Imported and called by the CLI `platine build` command.
   * Implemented in compile.ts to avoid circular imports.
   */
  compile(opts?: WorkflowCompileOptions): import("./manifest/schema.js").Manifest;
}

/** Options passed to WorkflowDef.compile(). */
export interface WorkflowCompileOptions {
  /** The agent ID / name used in the manifest's `agent` field. */
  agentId?: string;
  /** The human-readable name for the manifest. */
  name?: string;
  /** The model config for the manifest's `agent.model` field. */
  model?: {
    provider: "anthropic" | "bedrock";
    modelId: string;
    maxOutputTokens?: number;
  };
  /** The instructions string for the manifest's agent. */
  instructions?: string;
}

// ---------------------------------------------------------------------------
// Builder implementation — the runtime recording machinery
// ---------------------------------------------------------------------------

/**
 * @deprecated no-op — retained for source compatibility with call sites that
 * still invoke it (e.g. tests written before the SHOULD-FIX 3a change). The
 * node-id counter now lives on each BuilderImpl INSTANCE (see
 * BuilderImpl._nodeCounter / nextId), not a module-global, so every
 * `defineWorkflow()` call already starts its own counter at 0 regardless of
 * import environment/order — there is nothing left to reset. Two
 * programmatic build() calls in the SAME process no longer shift each
 * other's ids (the module-global was the bug: agent B's ids used to be
 * offset by however many nodes agent A had already recorded).
 */
export function _resetNodeCounter(): void {
  // Intentionally empty.
}

class BuilderImpl implements Builder {
  readonly _nodes: RecordedNode[] = [];
  readonly _edges: RecordedEdge[] = [];
  /** Per-instance node-id counter — see the _resetNodeCounter() doc comment above. */
  private _nodeCounter = 0;

  private _nextId(prefix: string): string {
    this._nodeCounter += 1;
    return `${prefix}_${this._nodeCounter}`;
  }

  private _addNode(node: RecordedNode): void {
    this._nodes.push(node);
  }

  private _addEdge(source: string, target: string): void {
    this._edges.push({
      edgeId: `e_${source}_${target}`,
      source,
      target,
    });
  }

  trigger<P extends Schema>(
    cfg: TriggerConfig & { payload: P }
  ): NodeHandle<Infer<P>> {
    const id = this._nextId("trigger");
    this._addNode({
      id,
      kind: "trigger",
      triggerConfig: cfg,
    });
    return { id } as NodeHandle<Infer<P>>;
  }

  node<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O> | AgentRef<I, O>,
    from: NodeHandle<Up>,
    mapper: (out: Up) => Infer<I>,
    opts?: { requiresApproval?: boolean }
  ): NodeHandle<Infer<O>> {
    const isAgentRef = (d: ToolDef<I, O> | AgentRef<I, O>): d is AgentRef<I, O> =>
      (d as AgentRef<I, O>).__kind === "agentRef";

    const kind: RecordedNodeKind = isAgentRef(def) ? "agent" : "tool";
    const actualDef: ToolDef<Schema, Schema> | AgentDef<Schema, Schema> = isAgentRef(def)
      ? def.__agentDef
      : (def as unknown as ToolDef<Schema, Schema>);

    const id = this._nextId(kind);
    this._addNode({
      id,
      kind,
      def: actualDef,
      ...(opts?.requiresApproval !== undefined
        ? { requiresApproval: opts.requiresApproval }
        : {}),
      mapper: mapper as (out: unknown) => unknown,
    });
    this._addEdge(from.id, id);
    return { id } as NodeHandle<Infer<O>>;
  }

  transform<Up, Out>(
    from: NodeHandle<Up>,
    fn: (out: Up) => Out
  ): NodeHandle<Out> {
    const id = this._nextId("transform");
    this._addNode({
      id,
      kind: "transform",
      fn: fn as (out: unknown) => unknown,
    });
    this._addEdge(from.id, id);
    return { id } as NodeHandle<Out>;
  }

  split<Up extends readonly unknown[]>(
    from: NodeHandle<Up>
  ): FanoutHandle<Up[number]> {
    const id = this._nextId("split");
    this._addNode({
      id,
      kind: "split",
    });
    this._addEdge(from.id, id);
    return { id, __fanout: true } as FanoutHandle<Up[number]>;
  }

  fanout<Elem, R>(
    from: FanoutHandle<Elem>,
    body: (item: NodeHandle<Elem>) => NodeHandle<R>,
    opts?: { concurrency?: number }
  ): NodeHandle<R[]> {
    const id = this._nextId("fanout");

    // Sub-recording: invoke the body EAGERLY, right now, against THIS builder
    // (not a mock) — so any b.node/b.transform/... calls inside the closure
    // are recorded into the SAME this._nodes/this._edges arrays the rest of
    // the graph uses. This is what makes elementSubgraph non-empty: the old
    // approach stashed the closure and had compile.ts call it later against a
    // disposable mock builder that was never wired as `b`, so it always
    // recorded zero inner nodes. It also means buildToolRegistry finds
    // sub-recorded tool nodes for free — they live in wf.nodes like any other.
    //
    // The synthetic itemHandle's id is never added as a real node, so the
    // edge from it into the body's first real node has a source that's absent
    // from the emitted manifest.nodes — compile.ts drops that edge, which is
    // exactly what identifies the body's first node as the subgraph's entry
    // (the member with no in-subgraph upstream edge).
    const captureStart = this._nodes.length;
    const itemHandle: NodeHandle<Elem> = { id: `${id}_item` } as NodeHandle<Elem>;
    // SHOULD-FIX 4: capture the body's RETURNED handle id — this is the node
    // whose per-item output the fanout must collect, which is NOT necessarily
    // the last-recorded / last-topo-order sub-node (a body can record an
    // audit/logging node AFTER the handle it actually returns). Discarding
    // this return value (the old behavior) silently let the executor collect
    // whichever sub-node happened to sort last, instead of what the body
    // actually returned.
    const terminalHandle = body(itemHandle);
    const subNodeIds = this._nodes.slice(captureStart).map((n) => n.id);

    this._addNode({
      id,
      kind: "fanout",
      fanoutBody: body as (item: NodeHandle<unknown>) => NodeHandle<unknown>,
      subNodeIds,
      terminalSubNodeId: terminalHandle.id,
      ...(opts?.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    });
    this._addEdge(from.id, id);
    return { id } as NodeHandle<R[]>;
  }

  merge<A, B>(a: NodeHandle<A>, b: NodeHandle<B>): NodeHandle<A & B> {
    const id = this._nextId("merge");
    this._addNode({
      id,
      kind: "merge",
      mergeSourceIds: [a.id, b.id],
    });
    this._addEdge(a.id, id);
    this._addEdge(b.id, id);
    return { id } as NodeHandle<A & B>;
  }

  output<T>(h: NodeHandle<T>): NodeHandle<T> {
    const id = this._nextId("output");
    this._addNode({
      id,
      kind: "output",
    });
    this._addEdge(h.id, id);
    return { id } as NodeHandle<T>;
  }

  unsafeNode<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O>,
    from: NodeHandle<Up>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapper: (out: Up) => any
  ): NodeHandle<Infer<O>> {
    const id = this._nextId("unsafe");
    this._addNode({
      id,
      kind: "unsafe",
      def: def as unknown as ToolDef<Schema, Schema>,
      mapper: mapper as (out: unknown) => unknown,
    });
    this._addEdge(from.id, id);
    return { id } as NodeHandle<Infer<O>>;
  }
}

// ---------------------------------------------------------------------------
// defineWorkflow — public factory
// ---------------------------------------------------------------------------

/**
 * Define a typed workflow.
 *
 * The function receives a Builder and must return the terminal NodeHandle
 * (typically wrapped with `b.output(handle)`). The builder records all nodes
 * and edges into a WorkflowDef that can be compiled to a Manifest.
 *
 * @example
 * export default defineWorkflow((b) => {
 *   const t = b.trigger({ type: "event", eventType: "ticket.created",
 *                          payload: z.object({ body: z.string() }) });
 *   const c = b.node(classify, t, (p) => ({ body: p.body }));
 *   const t2 = b.node(createTicket, c, (out) => ({
 *     subject: out.summary,
 *     priority: out.severity,
 *   }));
 *   return b.output(t2);
 * });
 */
export function defineWorkflow(
  fn: (b: Builder) => NodeHandle<unknown>
): WorkflowDef {
  const builder = new BuilderImpl();
  const outputHandle = fn(builder);

  const nodes: ReadonlyArray<RecordedNode> = [...builder._nodes];
  const edges: ReadonlyArray<RecordedEdge> = [...builder._edges];
  const outputNodeId = outputHandle.id;

    const workflowDef: WorkflowDef = {
    nodes,
    edges,
    outputNodeId,
    compile(opts?: WorkflowCompileOptions) {
      return _compileWorkflow(workflowDef, opts);
    },
  };

  return workflowDef;
}
