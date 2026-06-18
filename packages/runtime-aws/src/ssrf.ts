// SPDX-License-Identifier: Apache-2.0
/**
 * ssrf.ts — SSRF-safe fetch helper (SECURITY FIX HIGH 3).
 *
 * Used by the http_request transform to prevent Server-Side Request Forgery attacks.
 * Without this guard an attacker can craft a workflow that fetches
 * 169.254.169.254 (IMDS) or RFC1918 addresses and exfiltrates AWS credentials.
 *
 * Safety measures applied in order:
 *  1. Allow only http: and https: protocol schemes.
 *  2. DNS-resolve the target host (all A/AAAA records) and reject any address that
 *     falls within a blocked range: loopback, link-local, RFC1918, unspecified,
 *     IPv6 loopback (::1), IPv6 unique-local (fc00::/7), or IPv6 link-local (fe80::/10).
 *  3. Set redirect: "manual" and reject any 3xx response (re-validating the Location
 *     URL would require another DNS lookup cycle; refusing redirects is simpler and safe).
 *  4. Enforce an AbortSignal timeout (default 10 s) so stalled connections don't hang.
 *  5. Cap the response body size (default 10 MiB) to prevent memory exhaustion.
 */

import { lookup as dnsLookup } from "node:dns/promises";

// ---------------------------------------------------------------------------
// IP-range SSRF block-list
// ---------------------------------------------------------------------------

/** Parse a dotted-decimal IPv4 string to a 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return 0;
  let n = 0;
  for (const p of parts) {
    n = (n << 8) | (parseInt(p, 10) & 0xff);
  }
  return n >>> 0;
}

/**
 * Returns true when the IPv4 address falls inside the given CIDR.
 * @param ip      dotted-decimal IPv4 string
 * @param network dotted-decimal network address
 * @param prefix  prefix length (0-32)
 */
function isInCidrV4(ip: string, network: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/** Blocked IPv4 CIDR ranges. */
const BLOCKED_V4_CIDRS: ReadonlyArray<{ network: string; prefix: number }> = [
  { network: "0.0.0.0",         prefix: 8  }, // unspecified / "this" network
  { network: "10.0.0.0",        prefix: 8  }, // RFC1918
  { network: "100.64.0.0",      prefix: 10 }, // shared address space (carrier-grade NAT)
  { network: "127.0.0.0",       prefix: 8  }, // loopback
  { network: "169.254.0.0",     prefix: 16 }, // link-local (IMDS!)
  { network: "172.16.0.0",      prefix: 12 }, // RFC1918
  { network: "192.168.0.0",     prefix: 16 }, // RFC1918
  { network: "198.18.0.0",      prefix: 15 }, // benchmarking
  { network: "198.51.100.0",    prefix: 24 }, // TEST-NET-2
  { network: "203.0.113.0",     prefix: 24 }, // TEST-NET-3
  { network: "240.0.0.0",       prefix: 4  }, // reserved
  { network: "255.255.255.255", prefix: 32 }, // broadcast
];

/** Returns true when the IPv6 address string should be blocked. */
function isBlockedV6(addr: string): boolean {
  // Normalise to lower-case for comparison.
  const a = addr.toLowerCase();

  // ::1  loopback
  if (a === "::1") return true;
  // ::   unspecified
  if (a === "::") return true;

  // fe80::/10 — link-local
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) {
    return true;
  }
  // fc00::/7 — unique-local (fc00:: and fd00::)
  if (a.startsWith("fc") || a.startsWith("fd")) return true;

  // ::ffff:0:0/96 — IPv4-mapped; the embedded IPv4 is checked below after extraction.
  // We block the full range to be safe.
  if (a.startsWith("::ffff:")) return true;

  return false;
}

/** Returns true when the resolved IP address should be blocked. */
function isBlockedAddress(addr: string, family: 4 | 6): boolean {
  if (family === 6) return isBlockedV6(addr);
  return BLOCKED_V4_CIDRS.some(({ network, prefix }) => isInCidrV4(addr, network, prefix));
}

// ---------------------------------------------------------------------------
// ssrfSafeFetch
// ---------------------------------------------------------------------------

export interface SsrfSafeFetchOptions {
  /**
   * Abort signal timeout in milliseconds.
   * @default 10_000
   */
  timeoutMs?: number;
  /**
   * Maximum response body size in bytes before the response is rejected.
   * @default 10 * 1024 * 1024  (10 MiB)
   */
  maxBodyBytes?: number;
  /**
   * Optional DNS lookup function (injectable for unit tests — do NOT make real
   * network calls in tests).
   */
  dnsLookupFn?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;
}

/**
 * SSRF-safe fetch wrapper.
 *
 * Resolves the target URL's host via DNS and rejects any address in a blocked
 * range (loopback, link-local, RFC1918, IMDS …) before issuing the request.
 * Follows NO redirects.  Enforces a timeout and a response-body size cap.
 *
 * @throws {SsrfBlockedError} when the target URL is blocked.
 * @throws {Error}            for non-http/https schemes, timeout, or body overflow.
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit = {},
  options: SsrfSafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const lookupFn = options.dnsLookupFn ?? defaultDnsLookup;

  // 1. Protocol check.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ssrfSafeFetch: invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(
      `ssrfSafeFetch: blocked non-http/https scheme '${parsed.protocol}' for URL: ${url}`,
    );
  }

  const hostname = parsed.hostname;

  // 2. DNS resolution + block-list check.
  let records: ReadonlyArray<{ address: string; family: 4 | 6 }>;
  try {
    records = await lookupFn(hostname);
  } catch (err) {
    throw new Error(
      `ssrfSafeFetch: DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (records.length === 0) {
    throw new Error(`ssrfSafeFetch: DNS lookup returned no records for '${hostname}'`);
  }

  for (const record of records) {
    if (isBlockedAddress(record.address, record.family)) {
      throw new SsrfBlockedError(
        `ssrfSafeFetch: blocked request to '${hostname}' — resolved to blocked address ${record.address} (${record.family === 4 ? "IPv4" : "IPv6"})`,
      );
    }
  }

  // 3. Issue request: no redirects, with timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ssrfSafeFetch: request to '${url}' timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  clearTimeout(timer);

  // 4. Reject 3xx redirects outright (do not follow to unvalidated Location).
  if (resp.status >= 300 && resp.status < 400) {
    throw new SsrfBlockedError(
      `ssrfSafeFetch: redirect (${resp.status}) rejected for '${url}' — Location header not re-validated`,
    );
  }

  // 5. Response-body size cap: wrap the stream to count bytes.
  if (resp.body !== null) {
    const originalBody = resp.body;
    let bytesRead = 0;
    const capped = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBodyBytes) {
          controller.error(
            new Error(`ssrfSafeFetch: response body exceeds ${maxBodyBytes} bytes for '${url}'`),
          );
        } else {
          controller.enqueue(chunk);
        }
      },
    });
    const cappedBody = originalBody.pipeThrough(capped);
    // Re-wrap as a new Response so callers use .json()/.text() normally.
    return new Response(cappedBody, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  return resp;
}

/** Sentinel error type so callers can distinguish SSRF blocks from network errors. */
export class SsrfBlockedError extends Error {
  override readonly name = "SsrfBlockedError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Default DNS lookup (wraps node:dns/promises)
// ---------------------------------------------------------------------------

async function defaultDnsLookup(
  hostname: string,
): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  // lookup with {all: true} returns every A and AAAA record.
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }));
}
