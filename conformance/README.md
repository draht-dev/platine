<!-- SPDX-License-Identifier: Apache-2.0 -->
# @draht/conformance

The real-AWS conformance harness. Deploys a throwaway `sst` stage of
`examples/reference-playbook`, proves T3/T5/T6 against it (see
`docs/v1-status.md`), and **guarantees teardown** even on failure.

## Quick start

```bash
# Offline, zero-network, zero-AWS — proves the harness itself works.
pnpm conformance:dry-run

# Real AWS — requires credentials in your environment (see below).
pnpm conformance:real-aws -- --stage my-throwaway-stage --region eu-central-1 --dir examples/reference-playbook
```

`pnpm -F @draht/conformance test` runs the offline unit tests
(`sst-outputs.test.ts`, `teardown.test.ts`, `checks.test.ts`) — these never
touch AWS or the network.

## What it proves

| Check id | Proves |
|---|---|
| `t3-http-roundtrip` | POST ticket → 202 + runId → run leaves `queued` |
| `t6-approval-hold` | run reaches `awaiting_approval`; an `APPROVAL#<actionId>` row exists |
| `t5-survives-redeploy` | a **second**, independent held run survives a full `sst deploy` of the same stage, then resumes to `completed` |
| `t6-resume-iam` | unsigned POST to the resume URL → 403; SigV4-signed POST → 200 → `completed`; `SIDEEFFECT#` ledger row present |
| `tool-output` | asserts the classify node's real (non-stub) tool output — see below |

### `tool-output`: `DRAHT_ASSERT_TOOL_OUTPUT=1`

This check reuses the run submitted by `t3-http-roundtrip` /
`t6-approval-hold` (no second ticket is submitted) and, via `DynamoStorage`,
reads the classify node's `SIDEEFFECT#` ledger row directly. It asserts the
stored `result` is a non-empty object — not `{}` / a stub.

- **Unset (default): skipped.** The assertion is implemented, but requires
  Bedrock model access from the CI account (see below), so it stays
  gated-off by default.
- **`DRAHT_ASSERT_TOOL_OUTPUT=1`:** the assertion runs for real. This
  requires:
  - the reference-playbook's Bedrock model (`eu.anthropic.claude-haiku-4-5`,
    `eu-central-1` cross-region inference) to be enabled/accessible in the
    CI AWS account — otherwise the executor's model call itself fails before
    ever reaching classify's SIDEEFFECT# write, and this check fails with a
    "no SIDEEFFECT# row" error rather than skipping.
  - **expected cost**: negligible per run (a handful of short Haiku calls per
    conformance pass — well under $0.01/run at current Bedrock pricing), but
    it is a real, billed inference call, unlike every other check in this
    harness.

## CI gate: `.github/workflows/real-aws.yml`

The gate is **neutral-skip** until provisioned — it does not fail CI, it
simply does not run — controlled by the `AWS_CI_ROLE_ARN` repository
variable.

**Fork PRs**: a `real-aws`-labeled PR opened from a fork will still run this
job (the label + `pull_request` trigger conditions are satisfied), but it
will fail at the "Configure AWS credentials" step — forks do not receive the
repository's OIDC role-assumption permissions (`id-token: write` is scoped to
same-repo workflow runs only; GitHub does not forward it to fork-triggered
runs for security reasons). This is expected, not a neutral skip: maintainers
applying the `real-aws` label on a **same-repository branch** (not a fork) is
the intended path for exercising this gate on a PR.

### USER ACTION required to enable the gate

1. **Provision a throwaway AWS account** (strongly recommended — do NOT point
   this at a production account). The gate deploys and destroys real
   infrastructure on a schedule and on `real-aws`-labeled PRs.
2. **Create an IAM role** for GitHub Actions OIDC (`token.actions.githubusercontent.com`)
   scoped to **this repository** (trust policy `sub` condition like
   `repo:<org>/<repo>:*` — narrow further to specific branches/environments if
   your account policy requires it).
3. **Attach a policy** covering (least-privilege, deploy + destroy symmetry —
   the harness/teardown needs to both create and tear down every resource
   `@draht/sst` provisions):
   - Lambda: create/update/delete function, get/update function URL config
   - SQS: create/delete queue, get/set queue attributes
   - DynamoDB: create/delete table, describe table, **update-table**
     (`DeletionProtectionEnabled: false` — teardown cannot delete the
     `removal:'retain'` + `deletionProtection:true` managed table without this)
   - EventBridge: create/delete bus, put/remove rule, put/remove targets
   - CloudWatch: put/delete metric alarm
   - IAM: create/delete/pass the execution role(s) SST provisions for the
     Lambda functions (`iam:CreateRole`, `iam:DeleteRole`, `iam:PutRolePolicy`,
     `iam:PassRole`, etc., scoped to a role-name prefix if your account allows it)
4. **Set repository variables** (Settings → Secrets and variables → Actions → Variables):
   - `AWS_CI_ROLE_ARN` (**required**) — the role ARN from step 2. Leaving this
     unset is what keeps the gate neutral-skipped.
   - `AWS_CI_REGION` (optional, default `eu-central-1`).
5. **Label a PR `real-aws`** to run the gate on that PR (in addition to the
   nightly schedule and manual `workflow_dispatch`).

### USER ACTION required: back-fill the deploy-stdout fixture

`fixtures/deploy-stdout.txt` (used by `sst-outputs.test.ts`) is currently
**seeded** from the documented SST Ion `sst deploy` output format — it has
NOT been captured from a real deploy of `examples/reference-playbook`. The
fixture's own header comment carries this same note. After the **first**
real `pnpm conformance:real-aws` dispatch, replace the fixture's transcript
(below its comment banner) with the actual stdout captured from that run,
and remove the banner once confirmed accurate.

## Dry-run internals

`--dry-run` reads the SAME fixture through the SAME `parseSstOutputs()`
parser used in real mode, then wires an in-memory `MemoryStorage` (from
`@draht/runtime-aws`) to `src/fake-backend.ts`'s `makeFakeBackend()` — a
tiny in-process fake of the ingress/resume Lambda handlers that walks a run
through `queued → awaiting_approval → completed`. The SAME `fake-backend.ts`
module backs `checks.test.ts`'s offline unit tests, so the two environments
can never silently drift apart. No `fetch`, no AWS SDK client, no
`child_process` call to `sst`/`aws` is ever made in `--dry-run` mode.
Teardown prints the `planTeardown()` action list only.

## The `sst` CLI dependency

`deploy()`/`redeploy()` (via `@draht/platine`) and `teardownStage()`
(`src/teardown.ts`) both invoke the `sst` binary via `child_process`. The
`sst` package is a root-level `devDependency` (pinned to the major version
`@draht/sst`'s peerDependency range allows), so `pnpm exec sst version`
resolves from the repo root without any per-package install step. The
real-AWS workflow runs `pnpm exec sst version` as a fail-fast sanity check
immediately after `pnpm install`, before any AWS credentials are configured.
