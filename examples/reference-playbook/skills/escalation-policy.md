<!-- SPDX-License-Identifier: Apache-2.0 -->
# Skill: Escalation Policy

Escalate a ticket only when **all** of the following are true:

1. Severity is `high`.
2. The ticket has been classified (a `ticketId` is known).
3. A human reviewer has approved the escalation (the tool is approval-gated).

## Escalation reasons

Use one of these canonical reason strings:

| Category  | Reason string                                 |
|-----------|-----------------------------------------------|
| billing   | `billing-issue-requires-human-review`         |
| technical | `critical-technical-issue`                    |
| account   | `account-security-or-access-issue`            |
| other     | `high-priority-requires-human-review`         |

If no canonical reason matches, pass `requires-human-review` as a fallback.
