<!-- SPDX-License-Identifier: Apache-2.0 -->
# Skill: Classify Ticket

Given the raw text of a support ticket, produce a structured classification:

- **category**: one of `billing`, `technical`, `account`, `other`
- **severity**: one of `low`, `medium`, `high`
- **summary**: a ≤120-character plain-English description of the issue

## Examples

### Input
> "I was charged twice for my subscription last month and cannot log in."

### Output
```json
{
  "category": "billing",
  "severity": "high",
  "summary": "Double-charged for subscription; login failure."
}
```

### Input
> "The dark-mode toggle doesn't save my preference."

### Output
```json
{
  "category": "technical",
  "severity": "low",
  "summary": "Dark-mode preference not persisted."
}
```
