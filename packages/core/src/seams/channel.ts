// SPDX-License-Identifier: Apache-2.0
// Channel seam — inbound (verify+normalize) split from outbound (deliver/stream).

import type { InboundEnvelope, OutboundTarget } from "./types.js";

export interface InboundChannel {
  /** returns a discriminated result, NOT bare null */
  parse(req: {
    headers: Record<string, string>;
    body: string;
    rawBody: Buffer;
  }): Promise<
    | { kind: "run"; env: InboundEnvelope }
    | { kind: "ack"; response: unknown }
    | { kind: "reject" }
  >;
}

export interface OutboundChannel {
  deliver(target: OutboundTarget, message: string): Promise<void>;
  /** NDJSON/SSE */
  stream(target: OutboundTarget, tokens: AsyncIterable<string>): Promise<void>;
}
