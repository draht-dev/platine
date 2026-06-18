<!-- SPDX-License-Identifier: Apache-2.0 -->
# platine — honest positioning & competitive matrix

> Required by the v1 plan's adversarial must-fix **A.4**. The point of this doc is so
> the team does *not* over-believe its own differentiation and ship marketing that is
> trivially refuted. Lead with what is genuinely unoccupied; demote what is now
> table-stakes; never overclaim.

**One sentence:** platine is the only **Apache-2.0** agent framework that compiles a
**typed agent graph** into a versioned, inspectable **manifest** and deploys it as a
**single drop-in Pulumi/SST component into your own AWS account** — no runtime license
fees, no vendor-managed infra, no Vercel.

## The 5 pillars, graded against the field

| Pillar | Verdict | Who else has it | How to say it |
|---|---|---|---|
| **Apache-2.0 across the whole runtime** | ✅ **Unoccupied — lead with this** | LangGraph's production server is **ELv2** (a verified self-host trap) | "Permissive end-to-end. No relicense, no runtime fee." |
| **Single Pulumi/SST drop-in into the customer's own AWS account** | ✅ **Unoccupied — lead with this** | No surveyed framework ships an IaC component you add to an existing `sst.config.ts` | "Add `draht.Agent(...)` to your SST or raw-Pulumi app. Proven on a real deploy." |
| **Typed graph: `tsc` *rejects* a mis-wired edge** | ◑ **Narrow but real** | **Mastra has inter-step type inference** too | "We don't claim 'only one with inference.' We claim **compile-time assignability rejection at the call site** + the `FanoutHandle`/`[]` brand — proven by an independent probe + a CI fixture gate." |
| **Durability: checkpoint/resume + approval gate** | ⚠️ **Table-stakes, NOT a wedge** | OpenAI Agents SDK + Temporal, eve (Workflow SDK) | Required for the demo; **do not pitch as the differentiator.** |
| **Multi-tenant** | ⚠️ **Seam only in v1** | AWS Bedrock AgentCore has native per-session microVM isolation *today* | Say **"multi-tenant-ready seam, single-tenant default"** — never "multi-tenant." Win on cloud-agnostic + SaaS data-ownership + manifest-carried tenant metadata, not raw isolation. |
| **Playbooks** | ✅ Differentiator (1 shipped) | — | One installable, typed, end-to-end playbook in the distribution. |

## What does NOT get claimed
- ❌ "Mastra/competitors have no inter-step type inference." (False — Mastra propagates types via `.then()`.)
- ❌ "Durable execution / HITL is our wedge." (eve + OpenAI-SDK+Temporal already ship it.)
- ❌ "multi-tenant." (v1 ships the **seam** + single-tenant default only.)
- ❌ "SST partnership / `sst add draht`." SST is in maintenance mode (creator moved to OpenCode). Recast as **"Pulumi-ComponentResource-native, works in any SST *or* raw-Pulumi app."** Treat the SST community as advocacy, not a channel.

## The load-bearing proof
The single most defensible claim is **"has a real, non-toy user on this exact stack."**
The intended proof is the **fr3n consumer-#0 deployment** (P10 — one real fr3n agent
re-expressed in fr3n's SST app). v1 has additionally proven the deploy path against a
real throwaway AWS stage (see `docs/v1-status.md` → T2/T3/T5/T6).

## The empty intersection (why platine can exist)
Apache-2.0 end-to-end **+** a single Pulumi/SST drop-in into the customer's own AWS
account **+** compile-time edge-assignability rejection **+** a versioned inspectable
manifest a visual builder/CI can read **+** installable typed playbooks. No surveyed
competitor occupies that specific intersection.
