<!-- SPDX-License-Identifier: Apache-2.0 -->
# platine v1 — build status, acceptance, and known limitations

Built via multi-agent orchestration from the approved design + v1 plan
(`draht-mono/.planning/specs/2026-06-17-draht-agent-framework-*.md`). This is the
handoff: what exists, what's proven, and what's deferred.

## Packages (pnpm workspace, Apache-2.0, NodeNext, strict TS)

| Package | What it is |
|---|---|
| `@draht/core` | Authoring DSL (`define-tool/agent/workflow`), the Manifest schema + the single `derive()`, the 6 adapter **seams**, `compile`. **No barrel** — deep-subpath exports only. |
| `@draht/manifest` | Stable re-export pin of `@draht/core/manifest`. |
| `@draht/model` | `AnthropicModel` + `BedrockModel` (constructor-injectable), pure cost table, `createModel()`. No Vercel AI SDK. |
| `@draht/runtime-aws` | The level-scheduler `executor`, `runtime-local` (Memory adapters), `DynamoStorage`, `EventBridgeBus`, `HttpChannel`/`SlackChannel`, `AwsRuntime`, Lambda `handlers/*`, `ssrf` guard. |
| `@draht/sst` | The deploy surface: `draht.Agent`/`draht.Workflow` **factory** + pure `planResources()`. |
| `@draht/platine` | CLI (bin `platine`): `init / build / dev / deploy / runs`. |

Gate: **`pnpm verify`** = build (incl. `.d.ts`) + `tsgo --noEmit` (TypeScript 7) +
all tests + the mis-wire fixture gate. ~257 unit tests + 8 fixture-gate cases, all green.
Typecheck is **build-free**: cross-package `@draht/*` imports resolve to SOURCE via
centralized `paths` in `tsconfig.base.json`, so `tsgo` needs no prior build. (Packages
drop `composite`/`references`/`rootDir`/`outDir` — under tsgo those route resolution
through composite-project machinery that collapses deep Zod `z.infer` types to `any`;
tsup clears the paths in its dts worker so declaration emit still resolves via dist.)
The mis-wire fixture gate runs on the `typescript` 5.9 Compiler API, which is also what
tsup uses to emit `.d.ts`.

## Acceptance truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| T1 | A typed agent compiles to a manifest | ✅ local | `platine build` on the reference playbook → valid manifest |
| T4 | A mis-wired typed workflow fails `tsc` | ✅ local | `fixtures/miswire` (TS compiler-API gate) + an **independent adversarial probe** rejected 3 brand-new mis-wires at the exact line (TS2551/2322/2345); no false positives |
| T2 | Deploys to AWS via SST | ✅ **real AWS** | throwaway eu-central-1 stage (sst 4.15.2): the factory provisioned Lambda+SQS+DLQ+DynamoDB+EventBridge+routes+alarm+IAM |
| T3 | Answers on an HTTP channel end-to-end | ✅ **real AWS** | POST → deterministic runId → SQS → executor → DAG ran to completion (tool *results* stubbed — see gaps) |
| T5 | In-flight run survives a redeploy | ✅ **real AWS** | a run **held** at an approval survived a full `sst deploy` (`removal:'retain'`+`deletionProtection`) and resumed from the pinned manifest/checkpoint |
| T6 | Approval-gated tool holds → queue → resumes | ✅ **real AWS** | held → `APPROVAL#` row + `awaiting_approval` → IAM-auth resume → `completed`, with `SIDEEFFECT#` ledger rows for both steps |
| G  | fr3n dogfood | ⏳ **not done** | needs the fr3n repo (separate workspace) — see P10 below |

Durability is also proven locally against **DynamoDB Local** (real round-trip of every
row type + the executor durability suite on `DynamoStorage`) and via an adversarial
probe that found and got fixed a real `maxContinuations`→DLQ infinite-loop bug.

## Security posture (post-audit)
A parallel adversarial audit found and **fixed** 5 confirmed issues: the resume endpoint
is now IAM-authenticated; approval `actionId`s are `crypto.randomUUID()` (unforgeable);
`http_request` has an SSRF guard (IMDS/RFC1918/link-local blocked, no redirects, size/time
caps); IAM is scoped to specific ARNs (not `["*"]`); public HTTP ingress now warns.
`pnpm audit`: zero known-CVE dependencies.

## Known v1.x gaps (honest)
1. **CLOSED — deployed tool execution is real.** `platine build` now emits
   `.platine/executor.entry.ts`, which statically imports the agent's `workflow.ts` so
   SST/esbuild bundles the authored tool code into the executor Lambda. The entry calls
   `makeExecutorHandler({ workflow })`, which builds a per-agent tool registry
   (`buildToolRegistry` in `@draht/core/compile`, same `tool_<id>` scheme the manifest
   pins), wires `RealToolsDispatcher` (zod input validation before `execute()`), and
   resolves a real `Model` from env (`DRAHT_MODEL_PROVIDER`/`DRAHT_DEFAULT_MODEL`,
   injected by the SST factory; Bedrock via the execution role, IAM scoped to the
   configured model's foundation-model + inference-profile ARNs — no more `["*"]`).
   `platine dev` uses the same registry/dispatcher (it previously ran no real tools
   either). The legacy stub handler remains only as the fallback when no `entry` prop is
   passed. *Not yet re-proven on a live stage* — the conformance gate's `tool-output`
   check (opt-in via `DRAHT_ASSERT_TOOL_OUTPUT=1`) asserts it on the next real dispatch.
2. **CLOSED — fanout `elementSubgraph` executes.** The compiler now records fanout
   body nodes (the old path always emitted `[]`) and the executor runs the subgraph per
   item in topo order: ledger-guarded exactly-once sub-tool dispatch
   (`<runId>#FANOUT#<node>#<idx>#<subNode>` idempotency keys), per-item checkpoints,
   approval holds inside subgraphs, and resume that never re-runs completed items.
   Note: a fanout-using workflow compiles to a new manifest `revision` (the subgraph is
   no longer empty); `schemaVersion` is unchanged. Known residual: `transform` nodes
   still compile to empty `map` mappings regardless of the authored fn (pre-existing,
   tracked below).
3. **`real-aws.yml` is wired but neutral-skipped pending AWS credentials (USER ACTION).**
   The automated deploy → `@draht/conformance` checks (T3/T5/T6) → guaranteed-teardown
   gate now exists (`conformance/`, `.github/workflows/real-aws.yml`) and runs green
   offline (`pnpm conformance:dry-run`). It stays neutral-skipped in CI — not disabled,
   not failing — until the `AWS_CI_ROLE_ARN` repo variable is provisioned (a throwaway
   AWS account + OIDC role; see `conformance/README.md`). P7's redelivery+redeploy
   conformance was already proven **manually** against real AWS (T5/T6 above); this gate
   automates that same proof on a schedule + labeled PRs once credentials land.
4. **Storage uses raw `@aws-sdk/lib-dynamodb`, not ElectroDB.** The plan named ElectroDB;
   the impl uses the document client directly. Functionally equivalent — `transactWrite`
   atomicity is proven on DynamoDB Local *and* real AWS. Cosmetic spec divergence.
5. **`schemaVersion` is `z.string()`, not `z.literal()`.** Deliberate: the plan's
   `z.literal` was self-contradictory (it would reject `"2.0.0"` before the version-error
   check). Major-version compat is enforced in `parseManifest`.
6. **`transform` node compilation is a stub.** `compile.ts` emits `{type:"map",
   mappings:[]}` for every `b.transform`/mapping fn regardless of the authored function
   (the executor treats empty mappings as identity). Surfaced during the fanout work;
   closing it means compiling the mapping fn into declarative mappings (or embedding it
   like tool code).
7. Per the plan, also deferred to v2/v1.x: sub-step (mid-agent-loop) checkpointing;
   multi-tenant runtime impl (seam only); more channels/providers/clouds; visual builder;
   Temporal/Restate `Runtime` adapter; eval framework.

## Prerequisite before any publish
Confirm draht-dev owns the **`@draht`** npm org and can publish `@draht/platine`,
`@draht/core`, `@draht/manifest`, `@draht/model`, `@draht/runtime-aws`, `@draht/sst`.
The build publishes nothing.

## Next steps (priority order)
1. Provision `AWS_CI_ROLE_ARN` (throwaway account + OIDC role) so the already-wired
   `real-aws.yml` conformance gate starts running instead of neutral-skipping; on the
   first real dispatch, back-fill `conformance/fixtures/deploy-stdout.txt` and flip
   `DRAHT_ASSERT_TOOL_OUTPUT=1` to prove real tool execution live (closes the "not yet
   re-proven on a live stage" caveat on gap #1).
2. P10: re-express one real fr3n agent on platine, deploy in fr3n's SST app (pin
   `0.0.x-canary`), run the shared-table isolation test if `mode:"shared"`.
3. Compile `transform` mapping fns for real (gap #6).
