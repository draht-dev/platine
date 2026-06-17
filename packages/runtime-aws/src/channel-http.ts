// SPDX-License-Identifier: Apache-2.0
/**
 * channel-http.ts — HttpChannel implements InboundChannel + OutboundChannel.
 *
 * Inbound surface (eve-parity session API):
 *   POST /v1/sessions — verifies + normalizes a request body into a run envelope.
 *     Returns:
 *       { kind:"run", env }   — valid request, ready to submit
 *       { kind:"ack" }        — challenge / ping (URL verification, health)
 *       { kind:"reject" }     — invalid signature, malformed body, etc.
 *
 * Outbound surface:
 *   GET /v1/sessions/:id/stream — streams run output as NDJSON (one JSON object per line).
 *     Each line is a serialized { type, data } event.
 *
 * parse() NEVER returns bare null — always returns a discriminated result.
 */

import { createHash, createHmac } from "node:crypto";

import type { InboundChannel, OutboundChannel } from "@draht/core/seams";
import type { InboundEnvelope, OutboundTarget } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * ParseResult — discriminated union returned by parse().
 * Consumers must handle all three variants.
 */
export type HttpParseResult =
  | { kind: "run"; env: InboundEnvelope }
  | { kind: "ack"; response: unknown }
  | { kind: "reject" };

/**
 * HttpChannelOptions — configuration for the channel.
 */
export type HttpChannelOptions =
  | { channelId: string; authType: "bearer"; authToken: string }
  | { channelId: string; authType?: "none"; authToken?: never };

// ---------------------------------------------------------------------------
// HttpChannel
// ---------------------------------------------------------------------------

export class HttpChannel implements InboundChannel, OutboundChannel {
  private readonly channelId: string;
  private readonly authType: "bearer" | "none";
  private readonly authToken: string;

  constructor(opts: HttpChannelOptions) {
    this.channelId = opts.channelId;
    this.authType  = opts.authType ?? "none";
    this.authToken = opts.authType === "bearer" ? opts.authToken : "";
  }

  /**
   * parse() — verifies and normalizes an inbound HTTP request.
   *
   * Handles:
   * - Bearer token validation (when authType="bearer")
   * - JSON body parsing + normalization into InboundEnvelope
   * - Challenge/ping requests (body.type === "url_verification")
   * - Malformed or unauthorized requests → { kind: "reject" }
   */
  async parse(req: {
    headers: Record<string, string>;
    body: string;
    rawBody: Buffer;
  }): Promise<HttpParseResult> {
    // Auth check
    if (this.authType === "bearer") {
      const auth = req.headers["authorization"] ?? req.headers["Authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token.length === 0 || !timingSafeEqual(token, this.authToken ?? "")) {
        return { kind: "reject" };
      }
    }

    // Parse JSON body
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { kind: "reject" };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "reject" };
    }

    const body = parsed as Record<string, unknown>;

    // URL verification / challenge ping
    if (body["type"] === "url_verification") {
      return { kind: "ack", response: { challenge: body["challenge"] ?? "" } };
    }

    // Normalize to InboundEnvelope
    const payload: Record<string, unknown> = {};
    if (typeof body["payload"] === "object" && body["payload"] !== null) {
      Object.assign(payload, body["payload"] as Record<string, unknown>);
    } else {
      // Treat the whole body as payload (excluding meta fields)
      for (const [k, v] of Object.entries(body)) {
        if (k !== "channelId" && k !== "tenantHint") {
          payload[k] = v;
        }
      }
    }

    const env: InboundEnvelope = {
      channelId: typeof body["channelId"] === "string" ? body["channelId"] : this.channelId,
      payload,
      ...(typeof body["tenantHint"] === "string" ? { tenantHint: body["tenantHint"] } : {}),
      rawBody: req.body,
    };

    return { kind: "run", env };
  }

  /**
   * deliver() — sends a message to an outbound HTTP target.
   * POSTs the message as JSON to the target address.
   */
  async deliver(target: OutboundTarget, message: string): Promise<void> {
    await fetch(target.address, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: target.channelId, message }),
    });
  }

  /**
   * stream() — streams tokens to the target address as NDJSON.
   * Each token is emitted as a JSON line: {"type":"token","data":"<token>"}\n
   * A final {"type":"done"}\n line terminates the stream.
   *
   * This is used for GET /v1/sessions/:id/stream responses.
   */
  async stream(target: OutboundTarget, tokens: AsyncIterable<string>): Promise<void> {
    const lines: string[] = [];
    for await (const token of tokens) {
      lines.push(JSON.stringify({ type: "token", data: token }));
    }
    lines.push(JSON.stringify({ type: "done" }));
    const ndjson = lines.join("\n") + "\n";

    await fetch(target.address, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: ndjson,
    });
  }
}

// ---------------------------------------------------------------------------
// NDJSON streaming helpers (used by the ingress handler for SSE/NDJSON output)
// ---------------------------------------------------------------------------

/**
 * encodeNdjsonLine — encodes a single event as a NDJSON line.
 * Format: <JSON object>\n
 */
export function encodeNdjsonLine(event: Record<string, unknown>): string {
  return JSON.stringify(event) + "\n";
}

/**
 * encodeNdjsonStream — encodes a sequence of events as a NDJSON body.
 */
export async function* encodeNdjsonStream(
  tokens: AsyncIterable<string>,
): AsyncGenerator<string> {
  for await (const token of tokens) {
    yield encodeNdjsonLine({ type: "token", data: token });
  }
  yield encodeNdjsonLine({ type: "done" });
}

// ---------------------------------------------------------------------------
// Timing-safe comparison (prevents timing attacks on bearer tokens)
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Length differs — still do the compare to avoid timing leaks on length
    // (but it will always fail)
    const padded = b.padEnd(a.length, "\0");
    const hashA = createHash("sha256").update(a).digest();
    const hashB = createHash("sha256").update(padded).digest();
    return hashA.equals(hashB) && false; // always false when lengths differ
  }
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return hashA.equals(hashB);
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export { timingSafeEqual as _timingSafeEqual };

/**
 * buildSignatureHeader — generates an HMAC-SHA256 signature header value.
 * Used to test signature verification in SlackChannel, and for testing HttpChannel.
 */
export function buildHmacSignature(
  signingSecret: string,
  payload: string,
  prefix: string = "sha256=",
): string {
  const hmac = createHmac("sha256", signingSecret).update(payload).digest("hex");
  return `${prefix}${hmac}`;
}
