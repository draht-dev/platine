// SPDX-License-Identifier: Apache-2.0
// @draht/core/seams — adapter seam interfaces (P2/P3 implement concrete impls)
//
// Pure interfaces, ZERO AWS imports. All six seams live here:
//   Model, Storage, Runtime, Channel (InboundChannel + OutboundChannel), EventBus, Tenancy
//
// v2 Temporal/Restate swaps ONLY Runtime; reuses Model/Storage/Channel/EventBus/Tenancy unchanged.
// The Runtime seam is intentionally minimal: submit/resume/cancel/getRun only.
// No scheduling/level/fanout/continuation leaks into the seam (that's the whole point).

export {};
