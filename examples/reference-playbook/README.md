<!-- SPDX-License-Identifier: Apache-2.0 -->
# draht reference playbook — support-triage

A complete, end-to-end single-agent workflow that classifies incoming support
tickets and escalates high-severity ones to the human review queue via an
**approval-gated tool**.

## What this playbook demonstrates

| Concept | File |
|---|---|
| Agent instructions (markdown) | `agent.md` |
| Skill definitions | `skills/classify-ticket.md`, `skills/escalation-policy.md` |
| Typed tool (no approval) | `tools/classify.ts` |
| Typed tool (approval-gated) | `tools/escalate.ts` |
| Typed workflow DAG | `workflow.ts` |
| SST component wiring | `sst.ts`, `sst.config.ts` |
| Compiled manifest | `.platine/manifest.json` |

## Workflow graph

```
trigger (event: ticket.created, filters: priority=high)
  └─ classify   — tool, no approval required
      └─ escalate — tool, needsApproval: true (approval-gated)
```

## Deploy

### Prerequisites

- Node.js 20+
- pnpm 9+
- AWS credentials configured
- SST v4.15+ (`npm i -g sst`)

### Build the manifest

```bash
platine build
```

This typechecks `workflow.ts` + `tools/*.ts` and compiles the graph to
`.platine/manifest.json`.  The manifest must exist before `sst deploy`.

### Deploy to AWS

```bash
platine build && sst deploy --stage <name>
```

Example for a dev stage:

```bash
platine build && sst deploy --stage dev
```

The `sst deploy` command provisions:

- SQS queue + DLQ
- EventBridge bus
- DynamoDB table (managed, `removal:retain`, deletion-protected)
- Executor Lambda (subscribed to the queue)
- Ingress Lambda with Function URL (HTTP channel)
- Resume Lambda with Function URL (for approval gate)
- CloudWatch DLQ alarm

The stack outputs `SupportTriageAgentUrl` — the HTTP endpoint.

### End-to-end test

```bash
# 1. Submit a ticket event
curl -X POST "$SupportTriageAgentUrl" \
  -H "Content-Type: application/json" \
  -d '{"ticketId":"t_001","body":"I was charged twice and cannot log in."}'

# 2. List runs
platine runs list --table <DrahtTableName>

# 3. Approve the escalation
platine runs approve \
  --run-id <runId> \
  --action-id <actionId> \
  --decision approved \
  --by "reviewer@example.com"

# 4. Confirm completion
platine runs tail --run-id <runId>
```

## Local dev

```bash
# Run the workflow in-process (no AWS needed)
ANTHROPIC_API_KEY=sk-... platine dev
```

## Tear down

```bash
sst remove --stage <name>
```

Note: the DynamoDB table has `removal:retain` + deletion protection — it will
NOT be deleted on `sst remove`.  Delete it manually in the AWS Console if
needed.
