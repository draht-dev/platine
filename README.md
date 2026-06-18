<!-- SPDX-License-Identifier: Apache-2.0 -->
# platine

**The Apache-2.0 agent framework that compiles a typed agent graph into a versioned,
inspectable manifest and deploys it as a single drop-in Pulumi/SST component into your
own AWS account.** No runtime license fees, no vendor-managed infra, no Vercel.

> *draht* is the wire; *platine* (German for *circuit board*) is the board you wire
> agents onto. Built by draht-dev; fr3n is consumer #0.

```ts
// workflow.ts — wiring mistakes fail `tsc`, not runtime
export default defineWorkflow((b) => {
  const t = b.trigger({ type: "event", eventType: "ticket.created",
                        payload: z.object({ body: z.string() }) });
  const c = b.node(classify, t, (p) => ({ body: p.body }));      // p: { body: string }
  const e = b.node(escalate, c, (out) => ({                       // approval-gated tool
    ticketId: out.ticketId, reason: out.summary,                  // out: classify's output
    // reason: out.nope,   // ← TS2339 HERE, at the exact line
  }));
  return b.output(e);
});
```

```ts
// sst.config.ts — drop into your own AWS account
import { draht } from "@draht/sst";
export const agent = draht.Agent("SupportTriage", {
  manifest: "./.platine/manifest.json",
  model: { provider: "bedrock", defaultModel: "eu.anthropic.claude-haiku-4-5" },
  storage: { mode: "managed", retain: true },
  channels: [{ kind: "http" }],
  timeout: "14 minutes",
});
```

## Why it exists
Apache-2.0 across the *whole* runtime (LangGraph's production server is ELv2) **+** a
single Pulumi/SST `ComponentResource` that provisions Lambda + SQS + DynamoDB +
EventBridge into *your* account **+** compile-time rejection of a mis-wired edge **+** a
declarative, versioned manifest **+** installable typed playbooks — an intersection no
surveyed framework occupies. See [`docs/positioning.md`](docs/positioning.md) for the
honest competitive matrix (what's a wedge vs. table-stakes).

## CLI
```
platine init my-agent          # scaffold a typed agent directory
platine dev                    # run locally (in-process executor, hot reload)
platine build                  # tsc check → compile workflow.ts → .platine/manifest.json
platine deploy --stage dev     # platine build → sst deploy
platine runs list|approve|...  # inspect runs / resolve approval gates
```

## Architecture
```
AUTHORING (files) → COMPILE → MANIFEST (declarative, versioned, Zod-validated)
   agent.md / skills/*.md         │            ├─► @draht/sst factory → Pulumi/SST resources
   tools/*.ts (defineTool+zod)    │            └─► Runtime.execute(manifest, event)
   workflow.ts (typed graph) ─────┘                 topo-sort DAG · agent/tool/transform/fanout
   sst.ts                                            checkpoint→Storage each step (durable)
ADAPTER SEAMS: Model · Storage · Runtime · Channel · EventBus · Tenancy
RUNTIME v1 = AWS serverless (Lambda+SQS+DynamoDB+EventBridge), behind a minimal Runtime
seam so a durable engine (Temporal/Restate) can replace it in v2 with no rewrite.
```

## Status
P0–P9 built and verified; the deploy gate (T2/T3/T5/T6) proven on a real throwaway AWS
stage; the typed-graph wedge (T1/T4) proven by a CI fixture gate + an independent
adversarial probe. **Read [`docs/v1-status.md`](docs/v1-status.md)** for the full
acceptance results, the security posture, and the honest list of v1.x gaps — most
importantly: the *deployed* executor currently stubs user tool `execute()` (bundling user
tool code into the Lambda is the top v1.x item).

## Develop
```
pnpm install
pnpm verify       # build (+ .d.ts) + typecheck + tests + mis-wire fixture gate
```
Requires Node 20+, pnpm 9+. `@draht/core` is barrel-free — import deep subpaths
(`@draht/core/define-workflow`, `@draht/core/manifest`, `@draht/core/seams`).

## License
Apache-2.0 (library **and** runtime). Commercial add-ons, if any, live in a separate
`@draht/enterprise` package and never get imported by the Apache-2.0 runtime.
