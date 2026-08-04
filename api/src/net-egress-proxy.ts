/*
 * Per-job outbound HTTP proxy for sandbox network access.
 *
 * One instance per job, listening on an AF_UNIX socket owned by that job's
 * UID (mode 0600). Inside the jail, net-shim.c rewrites the client's
 * connect() onto this socket, so user code reaches it with ordinary
 * HTTP_PROXY/HTTPS_PROXY support and nothing else — without ever creating an
 * AF_INET socket, which seccomp still refuses outright.
 *
 * The trust boundary lives HERE, not in the shim. The shim only redirects one
 * endpoint and runs inside the sandbox; every decision about where bytes may
 * go is made in this file, on the trusted side, with no input from the sandbox
 * beyond the request head.
 *
 * Deliberate restrictions, each one closing a class of attack:
 *
 *   - One request per connection, `Connection: close` forced upstream. A
 *     connection is bound to a single validated origin for its whole life, so
 *     a pipelined or smuggled second request can never ride a connection that
 *     was authorized for a different host.
 *   - Length-delimited request bodies only. Chunked uploads are refused rather
 *     than parsed; a chunk parser here would be the one place in the design
 *     where sandbox-controlled framing drives trusted-side state.
 *   - Absolute-form http:// targets and CONNECT only. The proxy never
 *     originates TLS, so there is no certificate handling and no MITM surface;
 *     HTTPS is an opaque tunnel to an address this file approved.
 *   - Addresses are resolved once, every answer must pass the address gate,
 *     and the socket is opened to the pinned IP with the resolver bypassed.
 *     After connect, the kernel's view of the peer is re-checked. DNS
 *     rebinding therefore has no window to exploit.
 *   - Redirects are NOT followed. A 3xx goes back to the client, which issues
 *     a fresh proxied request that runs the full gate again.
 *
 * See net-policy.ts for the gates themselves.
 */

import dns from 'node:dns';
import fsp from 'node:fs/promises';
import net from 'node:net';
import {
  blockedAddressReason,
  checkHost,
  checkPort,
  checkTunnelSni,
  hostAllowlistInForce,
  inspectClientHelloSni,
  isIpLiteral,
  MAX_CLIENT_HELLO_BYTES,
  normalizeHost,
  verifyPinnedAddress,
  type NetPolicy,
} from './net-policy';
import { createTokenBucket } from './token-bucket';

export interface NetEgressProxyLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface NetEgressProxyOptions {
  socketPath: string;
  policy: NetPolicy;
  socketUid?: number;
  socketGid?: number;
  /** Concurrent client connections held open by the sandbox. */
  maxConnections?: number;
  /** Total requests this job may make. */
  maxRequests?: number;
  /** Total bytes proxied for this job, both directions combined. */
  maxTotalBytes?: number;
  /** Cap on a single request body (also counted against maxTotalBytes). */
  maxRequestBodyBytes?: number;
  /** Cap on the request line + headers block. */
  maxRequestHeadBytes?: number;
  /** Time allowed to deliver a complete request head after connecting. */
  headerTimeoutMs?: number;
  dnsTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Silence allowed on an established connection before it is torn down. */
  idleTimeoutMs?: number;
  connectionRateBurst?: number;
  connectionRateRefillPerSec?: number;
  log?: NetEgressProxyLogger;
  /** Test seams. `addressScreen` defaults to the real address gate and is
   * overridden only by data-path tests that need to reach a loopback origin;
   * the gate's own wiring is asserted by tests that leave it at the default. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  connect?: (opts: { host: string; port: number; family: number }) => net.Socket;
  addressScreen?: (ip: string) => string | null;
}

export interface NetEgressProxyStats {
  requests: number;
  allowed: number;
  denied: number;
  bytesUp: number;
  bytesDown: number;
  activeConnections: number;
}

export interface NetEgressProxyHandle {
  close: () => Promise<void>;
  stats: () => NetEgressProxyStats;
}

const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_REQUESTS = 512;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_HEAD_BYTES = 8192;
const DEFAULT_MAX_HEADER_COUNT = 64;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECTION_RATE_BURST = 64;
const DEFAULT_CONNECTION_RATE_REFILL_PER_SEC = 20;
/* Every answer is screened, so this is only a sanity bound on how long a list
 * an attacker-controlled name may make us walk. Well above what any real
 * round-robin returns. */
const MAX_SCREENED_ADDRESSES = 64;
const LISTEN_BACKLOG = 16;

/* TRACE and TRACK are reflection primitives; CONNECT is handled separately.
 * Anything not on this list is refused rather than forwarded. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/* Hop-by-hop headers (RFC 9110 7.6.1) plus the proxy-auth pair. Forwarding
 * any of these would leak the proxy's existence into the origin request or let
 * the sandbox pin connection semantics we deliberately control. */
const STRIPPED_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host',
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/* Visible ASCII plus space/tab. Rejects control characters, which are the
 * building block of header injection. */
const HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;

interface ParsedRequest {
  method: string;
  host: string;
  port: number;
  /** Origin-form target for the upstream request line; empty for CONNECT. */
  target: string;
  headers: [string, string][];
  contentLength: number;
  isConnect: boolean;
}

export class RequestRejected extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

/**
 * Parse and validate a complete request head. Throws RequestRejected for
 * anything that is not an unambiguous, single, length-delimited request.
 */
export function parseRequestHead(head: string, policy: NetPolicy): ParsedRequest {
  if (head.includes('\0')) throw new RequestRejected(400, 'NUL byte in request head');
  // Bare LF line endings let a request be framed two different ways by two
  // different parsers, which is the root of most smuggling. Require CRLF.
  if (/(^|[^\r])\n/.test(head)) throw new RequestRejected(400, 'bare LF in request head');

  const lines = head.split('\r\n');
  const requestLine = lines.shift() ?? '';
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const parts = requestLine.split(' ');
  if (parts.length !== 3) throw new RequestRejected(400, 'malformed request line');
  const [method, rawTarget, version] = parts;
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') {
    throw new RequestRejected(505, 'unsupported HTTP version');
  }
  const isConnect = method === 'CONNECT';
  if (!isConnect && !ALLOWED_METHODS.has(method)) {
    throw new RequestRejected(405, `method ${sanitize(method)} is not allowed`);
  }

  if (lines.length > DEFAULT_MAX_HEADER_COUNT) throw new RequestRejected(431, 'too many headers');

  const headers: [string, string][] = [];
  let contentLength = -1;
  let sawTransferEncoding = false;
  let sawHostHeader = false;
  for (const line of lines) {
    if (line.length === 0) throw new RequestRejected(400, 'empty header line');
    // A leading space is an obs-fold continuation; it is obsolete and is a
    // known way to hide a second header from a strict parser.
    if (line[0] === ' ' || line[0] === '\t') throw new RequestRejected(400, 'obs-fold header');
    const colon = line.indexOf(':');
    if (colon <= 0) throw new RequestRejected(400, 'malformed header');
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME_RE.test(name)) throw new RequestRejected(400, 'malformed header name');
    if (!HEADER_VALUE_RE.test(value)) throw new RequestRejected(400, 'malformed header value');
    const lower = name.toLowerCase();

    if (lower === 'content-length') {
      if (!/^[0-9]{1,15}$/.test(value)) throw new RequestRejected(400, 'malformed Content-Length');
      const parsed = Number(value);
      // Two Content-Length headers, or one repeated with a different value, is
      // an explicit smuggling signature.
      if (contentLength >= 0 && contentLength !== parsed) {
        throw new RequestRejected(400, 'conflicting Content-Length');
      }
      contentLength = parsed;
      continue;
    }
    if (lower === 'transfer-encoding') sawTransferEncoding = true;
    if (lower === 'host') {
      if (sawHostHeader) throw new RequestRejected(400, 'duplicate Host header');
      sawHostHeader = true;
    }
    if (lower === 'upgrade') throw new RequestRejected(400, 'Upgrade is not supported');
    if (STRIPPED_HEADERS.has(lower)) continue;
    headers.push([name, value]);
  }

  if (sawTransferEncoding) {
    // Chunked framing is refused, not parsed: see the file header.
    throw new RequestRejected(411, 'chunked request bodies are not supported; send Content-Length');
  }

  let host: string;
  let port: number;
  let target = '';
  if (isConnect) {
    const parsedAuthority = splitAuthority(rawTarget, -1);
    host = parsedAuthority.host;
    port = parsedAuthority.port;
    if (port < 0) throw new RequestRejected(400, 'CONNECT requires host:port');
    if (contentLength > 0) throw new RequestRejected(400, 'CONNECT must not carry a body');
    contentLength = 0;
  } else {
    if (!rawTarget.startsWith('http://')) {
      // origin-form ("GET /path") means the client did not think it was
      // talking to a proxy; https:// absolute-form would require the proxy to
      // originate TLS, which it deliberately cannot do.
      throw new RequestRejected(400, 'proxy requires an absolute http:// target (use CONNECT for https)');
    }
    let url: URL;
    try {
      url = new URL(rawTarget);
    } catch {
      throw new RequestRejected(400, 'malformed request target');
    }
    if (url.protocol !== 'http:') throw new RequestRejected(400, 'only http:// targets are proxied');
    if (url.username !== '' || url.password !== '') {
      throw new RequestRejected(400, 'credentials in the request target are not allowed');
    }
    const parsedAuthority = splitAuthority(url.host, 80);
    host = parsedAuthority.host;
    port = parsedAuthority.port;
    target = `${url.pathname}${url.search}`;
    if (target.length === 0) target = '/';
    if (contentLength < 0) contentLength = 0;
    if (contentLength > 0 && BODYLESS_METHODS.has(method)) {
      throw new RequestRejected(400, `${sanitize(method)} must not carry a body`);
    }
  }

  const hostVerdict = checkHost(host, policy);
  if (!hostVerdict.allowed) throw new RequestRejected(403, hostVerdict.reason);
  const portVerdict = checkPort(port, policy);
  if (!portVerdict.allowed) throw new RequestRejected(403, portVerdict.reason);

  return { method, host, port, target, headers, contentLength, isConnect };
}

/** Split 'host:port' or '[v6]:port'. `defaultPort` of -1 means the port is
 * mandatory. Throws RequestRejected on anything the host gate would not
 * recognize. */
function splitAuthority(raw: string, defaultPort: number): { host: string; port: number } {
  let hostPart: string;
  let portPart = '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) throw new RequestRejected(400, 'malformed IPv6 authority');
    hostPart = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest.length > 0) {
      if (rest[0] !== ':') throw new RequestRejected(400, 'malformed IPv6 authority');
      portPart = rest.slice(1);
    }
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon >= 0) {
      hostPart = raw.slice(0, colon);
      portPart = raw.slice(colon + 1);
    } else {
      hostPart = raw;
    }
  }

  const host = normalizeHost(hostPart);
  if (host === null) throw new RequestRejected(400, 'malformed host');

  if (portPart.length === 0) return { host, port: defaultPort };
  if (!/^[0-9]{1,5}$/.test(portPart)) throw new RequestRejected(400, 'malformed port');
  return { host, port: Number(portPart) };
}

/** Keep sandbox-controlled text out of our own error responses and logs. */
function sanitize(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').slice(0, 64);
}

export async function createNetEgressProxy(opts: NetEgressProxyOptions): Promise<NetEgressProxyHandle> {
  const {
    socketPath,
    policy,
    socketUid,
    socketGid,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    maxRequests = DEFAULT_MAX_REQUESTS,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
    maxRequestHeadBytes = DEFAULT_MAX_REQUEST_HEAD_BYTES,
    headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
    dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    connectionRateBurst = DEFAULT_CONNECTION_RATE_BURST,
    connectionRateRefillPerSec = DEFAULT_CONNECTION_RATE_REFILL_PER_SEC,
    addressScreen = blockedAddressReason,
    log,
  } = opts;

  const lookupAddresses = opts.lookup ?? defaultLookup;
  /* `host` is always the literal address the policy pinned. Node skips the
   * resolver for IP literals, but the explicit `lookup` makes that a property
   * of this call rather than of the runtime's parsing: no future Node/Bun
   * behavior change can turn this back into a name resolution. */
  const connectUpstream =
    opts.connect ??
    ((o) =>
      net.connect({
        host: o.host,
        port: o.port,
        family: o.family,
        lookup: (_hostname, _options, callback) => callback(null, o.host, o.family),
      }));
  const rateBucket = createTokenBucket({ burst: connectionRateBurst, refillPerSec: connectionRateRefillPerSec });

  const stats: NetEgressProxyStats = {
    requests: 0,
    allowed: 0,
    denied: 0,
    bytesUp: 0,
    bytesDown: 0,
    activeConnections: 0,
  };
  const sockets = new Set<net.Socket>();
  let closed = false;

  function budgetExhausted(): boolean {
    return stats.bytesUp + stats.bytesDown >= maxTotalBytes;
  }

  const server = net.createServer({ allowHalfOpen: false }, client => {
    if (closed) {
      client.destroy();
      return;
    }
    // Drop over-cap and flooding connections without a response: answering
    // would cost an allocation per attempt, which is what a flood wants.
    if (sockets.size >= maxConnections || !rateBucket.tryConsume()) {
      client.destroy();
      return;
    }
    sockets.add(client);
    stats.activeConnections = sockets.size;
    handleClient(client).catch(() => client.destroy());
  });

  async function handleClient(client: net.Socket): Promise<void> {
    let upstream: net.Socket | null = null;
    let settled = false;
    let head: ParsedRequest | null = null;
    const startedAt = Date.now();

    const timers = createTimerSet();
    /* Set once the connection is finished with, so the async steps below
     * (DNS, connect) can bail out. Without it, a client that disconnects
     * mid-resolve would still cause an outbound connection to be opened and
     * then abandoned — a sandbox could use that to make the runner dial hosts
     * it never intends to talk to. */
    let torn = false;
    const cleanup = (): void => {
      torn = true;
      timers.clearAll();
      sockets.delete(client);
      stats.activeConnections = sockets.size;
      client.destroy();
      upstream?.destroy();
    };
    client.on('close', cleanup);
    client.on('error', cleanup);

    const fail = (status: number, reason: string): void => {
      if (settled) {
        cleanup();
        return;
      }
      settled = true;
      stats.denied++;
      log?.warn(
        { host: head?.host, port: head?.port, status, reason },
        'sandbox egress denied',
      );
      // A minimal, fixed-shape response: nothing here echoes sandbox input
      // except the sanitized reason, which is useful when debugging a job.
      const body = `${status} ${sanitize(reason)}\n`;
      client.end(
        `HTTP/1.1 ${status} Proxy Error\r\n` +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n\r\n' +
          body,
      );
      timers.set('lingering-close', () => cleanup(), 1_000);
    };

    if (stats.requests >= maxRequests) {
      fail(429, 'per-job request limit reached');
      return;
    }
    if (budgetExhausted()) {
      fail(429, 'per-job network byte budget exhausted');
      return;
    }
    stats.requests++;

    let buffered: Buffer;
    try {
      buffered = await readRequestHead(client, timers, maxRequestHeadBytes, headerTimeoutMs);
    } catch (error) {
      fail(error instanceof RequestRejected ? error.status : 400, describe(error));
      return;
    }

    const separator = buffered.indexOf('\r\n\r\n');
    const headText = buffered.subarray(0, separator).toString('latin1');
    let body = buffered.subarray(separator + 4);

    try {
      head = parseRequestHead(headText, policy);
    } catch (error) {
      fail(error instanceof RequestRejected ? error.status : 400, describe(error));
      return;
    }

    if (!head.isConnect) {
      if (head.contentLength > maxRequestBodyBytes) {
        fail(413, 'request body exceeds the per-request limit');
        return;
      }
      // Bytes beyond Content-Length on a request we are about to forward can
      // only be a pipelined second request. Refuse the connection outright.
      if (body.length > head.contentLength) {
        fail(400, 'pipelined request after a length-delimited body');
        return;
      }
    }

    let pinned: { address: string; family: number };
    try {
      pinned = await resolveAndScreen(head.host, lookupAddresses, dnsTimeoutMs, addressScreen);
    } catch (error) {
      fail(error instanceof RequestRejected ? error.status : 502, describe(error));
      return;
    }
    if (torn) return;

    let socket: net.Socket;
    try {
      socket = await openUpstream(
        connectUpstream,
        { host: pinned.address, port: head.port, family: pinned.family },
        timers,
        connectTimeoutMs,
        // Publish the socket before it finishes connecting so a teardown during
        // the dial destroys it now rather than at the connect timeout.
        pending => {
          upstream = pending;
          if (torn) pending.destroy();
        },
      );
    } catch (error) {
      fail(502, describe(error));
      return;
    }
    upstream = socket;
    if (torn) {
      socket.destroy();
      return;
    }

    const pinVerdict = verifyPinnedAddress(socket.remoteAddress, pinned.address, addressScreen);
    if (!pinVerdict.allowed) {
      socket.destroy();
      fail(502, pinVerdict.reason);
      return;
    }

    settled = true;
    stats.allowed++;
    const approved = head;
    log?.info(
      { method: approved.method, host: approved.host, port: approved.port, address: pinned.address },
      'sandbox egress allowed',
    );

    /* Per-connection counters. The `stats` totals are per JOB and must never
     * be used for request framing — mixing the two would let one request's
     * body budget be consumed by an earlier request on another connection. */
    let bodyForwarded = 0;
    let connBytesDown = 0;

    const onOverrun = (reason: string): void => {
      log?.warn({ host: approved.host, reason }, 'sandbox egress connection torn down');
      cleanup();
    };

    /* CONNECT authorizes an authority, not an IP. When a host allowlist is what
     * decides access, the tunnel has to actually go to the name that was
     * allowed: an allowlisted host sharing an address with other virtual hosts
     * — the normal case on a CDN or shared hosting — would otherwise let the
     * sandbox CONNECT to the allowed name and put a different one in the TLS
     * SNI, and the server routes on SNI. So hold the client's first bytes,
     * read the ClientHello (read-only; TLS is still never terminated) and run
     * the same host gate on the name it asks for.
     *
     * Only when an allowlist is in force: with none, the policy is already "any
     * publicly routable address", and a different SNI to a screened public
     * address reaches nothing a second CONNECT could not. */
    let sniPending = approved.isConnect && hostAllowlistInForce(policy);
    let helloBuffer = Buffer.alloc(0);

    /** Write client bytes upstream, holding them back while the ClientHello is
     * still being read. Returns false when the socket asked for backpressure. */
    const forwardUp = (chunk: Buffer): boolean => {
      if (!sniPending) return socket.write(chunk);

      helloBuffer = Buffer.concat([helloBuffer, chunk]);
      if (helloBuffer.length > MAX_CLIENT_HELLO_BYTES) {
        onOverrun('CONNECT tunnel sent no parseable TLS ClientHello');
        return false;
      }
      const verdict = inspectClientHelloSni(helloBuffer);
      if (verdict.status === 'need-more') return true;
      if (verdict.status !== 'ok') {
        // A tunnel we cannot bind to a name is indistinguishable from one being
        // used to reach a different one, so it does not get to proceed.
        onOverrun(`CONNECT tunnel did not open with a TLS ClientHello (${verdict.status})`);
        return false;
      }
      const sniVerdict = checkTunnelSni(verdict.sni, approved.host, policy);
      if (!sniVerdict.allowed) {
        stats.denied++;
        log?.warn(
          { host: approved.host, sni: verdict.sni, reason: sniVerdict.reason },
          'sandbox egress denied',
        );
        onOverrun(sniVerdict.reason);
        return false;
      }
      sniPending = false;
      const held = helloBuffer;
      helloBuffer = Buffer.alloc(0);
      return socket.write(held);
    };

    if (approved.isConnect) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    } else {
      /* The rebuilt head carries the job's own path and headers upstream, so it
       * is data leaving the sandbox and belongs in the byte budget. Counting
       * only bodies let a job spend the head limit per request for free. */
      const upstreamHead = buildUpstreamHead(approved);
      stats.bytesUp += Buffer.byteLength(upstreamHead);
      socket.write(upstreamHead);
    }
    if (body.length > 0) {
      bodyForwarded += body.length;
      stats.bytesUp += body.length;
      /* Same budget check the streaming path applies. A client that coalesced
       * its body with the head arrives here instead of in 'data', and without
       * this it got one free body past an exhausted budget. */
      if (budgetExhausted()) {
        onOverrun('per-job byte budget exhausted');
        return;
      }
      forwardUp(body);
    }
    body = Buffer.alloc(0);

    client.on('data', chunk => {
      if (!approved.isConnect) {
        bodyForwarded += chunk.length;
        // Anything past Content-Length on a forwarded request is a pipelined
        // or smuggled second request; it never reaches upstream.
        if (bodyForwarded > approved.contentLength) {
          onOverrun('client sent more body than Content-Length');
          return;
        }
      }
      stats.bytesUp += chunk.length;
      if (budgetExhausted()) {
        onOverrun('per-job byte budget exhausted');
        return;
      }
      timers.set('idle', () => onOverrun('idle timeout'), idleTimeoutMs);
      if (!forwardUp(chunk)) client.pause();
    });
    socket.on('drain', () => client.resume());

    socket.on('data', chunk => {
      connBytesDown += chunk.length;
      stats.bytesDown += chunk.length;
      if (budgetExhausted()) {
        onOverrun('per-job byte budget exhausted');
        return;
      }
      timers.set('idle', () => onOverrun('idle timeout'), idleTimeoutMs);
      if (!client.write(chunk)) socket.pause();
    });
    client.on('drain', () => socket.resume());

    /* Upstream FIN means the response is complete (we forced
     * `Connection: close`). End the client side gracefully so buffered
     * response bytes flush — destroying here would truncate the last write —
     * and hard-close shortly after in case the client never reads. */
    socket.on('end', () => {
      timers.clear('idle');
      log?.info(
        {
          host: approved.host,
          port: approved.port,
          method: approved.method,
          bytes_up: bodyForwarded,
          bytes_down: connBytesDown,
          ms: Date.now() - startedAt,
        },
        'sandbox egress completed',
      );
      client.end();
      timers.set('lingering-close', cleanup, 5_000);
    });
    // The client going away first (user code closed the socket) has no
    // response left to deliver, so tear the upstream down immediately.
    client.on('end', () => socket.end());
    socket.on('error', () => cleanup());
    socket.on('close', () => timers.set('lingering-close', cleanup, 1_000));
    timers.set('idle', () => onOverrun('idle timeout'), idleTimeoutMs);

    // Data buffered while we were resolving and connecting is still queued:
    // readRequestHead paused the socket precisely so none of it was dropped
    // between parsing the head and attaching these handlers.
    client.resume();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath, backlog: LISTEN_BACKLOG }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  /* Past this point the server is listening, so anything that throws has to
   * take the listener down with it. The caller only knows the socket path and
   * unlinks that; an FD left listening on an unlinked path is unreachable but
   * still alive, and with networking on that is one leaked listener per job
   * until the runner is out of descriptors. */
  try {
    // Ownership first, then mode: between listen() and chown the socket exists
    // with the runner's ownership, and 0600 on the wrong owner is still closed
    // to the job. chmod last means the job-readable state is only ever reached
    // after the uid is correct.
    if (socketUid !== undefined && socketGid !== undefined) {
      await fsp.chown(socketPath, socketUid, socketGid);
    }
    await fsp.chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fsp.rm(socketPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    stats: () => ({ ...stats, activeConnections: sockets.size }),
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fsp.rm(socketPath, { force: true }).catch(() => {});
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof RequestRejected) return error.reason;
  if (error instanceof Error) return sanitize(error.message);
  return 'proxy error';
}

/** Rebuild the request head in origin form for the upstream connection.
 * Exported for tests: this is what the origin actually receives. */
export function buildUpstreamHead(request: ParsedRequest): string {
  const lines = [`${request.method} ${request.target} HTTP/1.1`];
  // An IPv6 literal must be bracketed in a Host header, otherwise its colons
  // are read as the port separator.
  const hostForHeader = request.host.includes(':') ? `[${request.host}]` : request.host;
  const hostHeader = request.port === 80 ? hostForHeader : `${hostForHeader}:${request.port}`;
  lines.push(`Host: ${hostHeader}`);
  for (const [name, value] of request.headers) lines.push(`${name}: ${value}`);
  // Always frame methods that may carry a body, including the zero-length
  // case: an origin that sees no Content-Length on a POST is entitled to wait
  // for a body that will never arrive.
  if (!BODYLESS_METHODS.has(request.method)) lines.push(`Content-Length: ${request.contentLength}`);
  lines.push('Connection: close');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

interface TimerSet {
  set: (name: string, fn: () => void, ms: number) => void;
  clear: (name: string) => void;
  clearAll: () => void;
}

/* Timers are managed explicitly rather than via socket.setTimeout: the runner
 * executes under Bun, whose socket timeout semantics differ from Node's, and
 * a silently non-firing timeout here would mean a job could pin proxy state
 * open for its whole wall-clock budget. */
function createTimerSet(): TimerSet {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    set(name, fn, ms) {
      const existing = timers.get(name);
      if (existing) clearTimeout(existing);
      timers.set(name, setTimeout(fn, ms));
    },
    clear(name) {
      const existing = timers.get(name);
      if (existing) clearTimeout(existing);
      timers.delete(name);
    },
    clearAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Read until CRLFCRLF, bounded by size and time. */
function readRequestHead(
  client: net.Socket,
  timers: TimerSet,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      client.removeListener('data', onData);
      client.removeListener('end', onEnd);
      timers.clear('header');
      fn();
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      const buffer = Buffer.concat(chunks);
      const separator = buffer.indexOf('\r\n\r\n');
      /* Bound the HEAD, not the read. HTTP clients routinely coalesce the
       * header write with `end(body)`, so the first chunk of an ordinary upload
       * carries the whole body too; measuring `size` before locating the
       * terminator turned every POST over ~maxBytes into a 431. Once the
       * terminator is in hand the head is exactly the bytes before it, and the
       * body that rode along is bounded by the Content-Length checks the caller
       * applies. Only a client that never sends a terminator is capped on the
       * running total. */
      if (separator >= 0) {
        if (separator + 4 > maxBytes) {
          settle(() => reject(new RequestRejected(431, 'request head too large')));
          return;
        }
        // Pause before returning: the caller now awaits DNS and connect, and
        // removing the 'data' listener alone would leave the socket flowing
        // with nobody reading — body bytes sent during that window would be
        // silently dropped. The paused socket buffers them until resume().
        client.pause();
        settle(() => resolve(buffer));
        return;
      }
      if (size > maxBytes) {
        settle(() => reject(new RequestRejected(431, 'request head too large')));
      }
    };
    const onEnd = (): void => settle(() => reject(new RequestRejected(400, 'connection closed before a complete request')));

    client.on('data', onData);
    client.on('end', onEnd);
    timers.set('header', () => settle(() => reject(new RequestRejected(408, 'timed out reading the request head'))), timeoutMs);
  });
}

async function defaultLookup(host: string): Promise<{ address: string; family: number }[]> {
  const results = await dns.promises.lookup(host, { all: true, verbatim: true });
  return results.map(r => ({ address: r.address, family: r.family }));
}

/**
 * Resolve a host and screen every answer. Returns the address the connection
 * must be pinned to.
 *
 * Every returned address must pass the gate, not just the one we intend to
 * use: a name that answers with a public AND a private address is a
 * split-horizon or rebinding setup, and serving the public half would still
 * let the sandbox use timing to map the private half.
 */
async function resolveAndScreen(
  host: string,
  lookup: (host: string) => Promise<{ address: string; family: number }[]>,
  timeoutMs: number,
  screen: (ip: string) => string | null,
): Promise<{ address: string; family: number }> {
  if (isIpLiteral(host)) {
    const blocked = screen(host);
    if (blocked !== null) throw new RequestRejected(403, `address is not publicly routable: ${blocked}`);
    return { address: host, family: host.includes(':') ? 6 : 4 };
  }

  let results: { address: string; family: number }[];
  try {
    results = await withTimeout(lookup(host), timeoutMs, 'DNS lookup timed out');
  } catch (error) {
    if (error instanceof RequestRejected) throw error;
    throw new RequestRejected(502, 'DNS lookup failed');
  }
  if (results.length === 0) throw new RequestRejected(502, 'DNS lookup returned no addresses');
  /* Refuse an answer set too large to be a real one rather than truncating it.
   * Screening is pure and cheap, so the only reason for a bound here is to stop
   * an attacker-controlled name from making us parse an unbounded list. */
  if (results.length > MAX_SCREENED_ADDRESSES) {
    throw new RequestRejected(502, 'DNS lookup returned an implausible number of addresses');
  }

  /* Screen EVERY answer before picking one. Truncating to the first
   * MAX_RESOLVED_ADDRESSES first would have dropped a private answer sitting at
   * position nine, and the request would then be allowed on the strength of the
   * eight in front of it — exactly the split-horizon case the whole-set rule
   * exists for. */
  for (const result of results) {
    const blocked = screen(result.address);
    if (blocked !== null) {
      throw new RequestRejected(403, `host resolves to a non-public address: ${blocked}`);
    }
  }
  return results[0];
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestRejected(504, message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Dial upstream with a bounded connect timeout.
 *
 * `register` is handed the socket synchronously, before the connect completes,
 * so the caller's teardown can destroy an in-flight dial. Without it a client
 * that disconnects mid-connect releases its `maxConnections` slot immediately
 * while the outbound socket lives on until its connect timeout — one job could
 * hold far more pending host connections than the limit advertises.
 */
function openUpstream(
  connect: (opts: { host: string; port: number; family: number }) => net.Socket,
  target: { host: string; port: number; family: number },
  timers: TimerSet,
  timeoutMs: number,
  register?: (socket: net.Socket) => void,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(target);
    register?.(socket);
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      timers.clear('connect');
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      fn();
    };
    const onConnect = (): void => settle(() => resolve(socket));
    const onError = (): void => settle(() => {
      socket.destroy();
      reject(new RequestRejected(502, 'upstream connection failed'));
    });
    socket.on('connect', onConnect);
    socket.on('error', onError);
    timers.set('connect', () => settle(() => {
      socket.destroy();
      reject(new RequestRejected(504, 'upstream connection timed out'));
    }), timeoutMs);
  });
}
