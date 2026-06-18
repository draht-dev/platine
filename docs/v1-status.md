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

Gate: **`pnpm verify`** = build (incl. `.d.ts`) + `tsc --noEmit` + all tests + the
mis-wire fixture gate. ~257 unit tests + 8 fixture-gate cases, all green.

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
1. **Deployed tool execution is stubbed (TOP item).** The deployed executor
   (`handlers/executor.ts`) wires `StubToolsDispatcher` (returns `{}` + warns) and
   `NoopModel`. It runs the full DAG + checkpoint/resume + approval-gate + ledger
   machinery, but does **not** execute the user's authored tool `execute()` code or call
   the model. Closing this needs **bundling the agent's compiled `tools/*.ts` into the
   executor Lambda + a per-agent tool registry**, and wiring a real `Model` from
   `@draht/model` (Bedrock via the execution role). Until then, deployed runs exercise
   durability/approval, not tool business logic.
2. **Fanout subgraph not executed.** `b.split`/`b.fanout` checkpoint per item but the
   executor passes items through (`itemOut = item`) rather than running the
   `elementSubgraph`. v1 = "basic fan-out"; full subgraph execution is v1.x.
3. **`real-aws.yml` is a disabled stub (`if: false`).** P7's redelivery+redeploy
   conformance was proven **manually** (T5/T6 above). Wiring it as an automated CI gate
   needs CI AWS credentials + a deploy/redeploy/teardown harness.
4. **Storage uses raw `@aws-sdk/lib-dynamodb`, not ElectroDB.** The plan named ElectroDB;
   the impl uses the document client directly. Functionally equivalent — `transactWrite`
   atomicity is proven on DynamoDB Local *and* real AWS. Cosmetic spec divergence.
5. **`schemaVersion` is `z.string()`, not `z.literal()`.** Deliberate: the plan's
   `z.literal` was self-contradictory (it would reject `"2.0.0"` before the version-error
   check). Major-version compat is enforced in `parseManifest`.
6. Per the plan, also deferred to v2/v1.x: sub-step (mid-agent-loop) checkpointing;
   multi-tenant runtime impl (seam only); more channels/providers/clouds; visual builder;
   Temporal/Restate `Runtime` adapter; eval framework.

## Prerequisite before any publish
Confirm draht-dev owns the **`@draht`** npm org and can publish `@draht/platine`,
`@draht/core`, `@draht/manifest`, `@draht/model`, `@draht/runtime-aws`, `@draht/sst`.
The build publishes nothing.

## Next steps (priority order)
1. Bundle user tool code + wire the real Model into the deployed executor (gap #1).
2. P10: re-express one real fr3n agent on platine, deploy in fr3n's SST app (pin
   `0.0.x-canary`), run the shared-table isolation test if `mode:"shared"`.
3. Enable `real-aws.yml` as an automated conformance gate.
4. Fanout subgraph execution (gap #2).
