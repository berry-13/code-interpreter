/*
 * Egress policy for sandbox network access (CODEAPI_ALLOW_SANDBOX_NETWORK).
 *
 * Pure and dependency-free so every rule is unit-testable without opening a
 * socket. The proxy in net-egress-proxy.ts is the only caller; it must consult
 * these functions BEFORE it connects anywhere, and again after connecting
 * (verifyPinnedAddress) because the kernel — not DNS — decides where a socket
 * actually landed.
 *
 * Three independent gates, all deny-by-default:
 *
 *   1. Host gate      — syntax, an operator suffix denylist, and the optional
 *                       operator allowlist (SANDBOX_NET_ALLOWED_HOSTS).
 *   2. Port gate      — SANDBOX_NET_ALLOWED_PORTS, default 80,443.
 *   3. Address gate   — every address the resolver returned must be publicly
 *                       routable. One blocked answer rejects the whole request.
 *
 * The address gate is the load-bearing one: with no allowlist configured the
 * host gate passes anything syntactically valid, so "is this IP allowed to be
 * reached from a trusted network position" is the only thing standing between
 * untrusted code and the operator's internal network, the cloud metadata
 * service, and the runner's own loopback services.
 */

export interface NetPolicy {
  /** Empty = any host that survives the other gates. Entries are exact hosts
   * ('api.github.com') or a single leading-wildcard label ('*.pypi.org', which
   * matches sub.pypi.org and pypi.org itself). */
  allowedHosts: string[];
  /** Deny every host regardless of `allowedHosts`. Set when the operator
   * configured SANDBOX_NET_ALLOWED_HOSTS but no entry survived validation:
   * an empty `allowedHosts` otherwise means "no allowlist", so without this
   * a single typo in a restrictive policy would open egress to every public
   * host. Startup also refuses this configuration; the flag is the runtime
   * half of the same guarantee. */
  denyAllHosts?: boolean;
  allowedPorts: number[];
  /** Deny every port regardless of `allowedPorts`. Set when the operator
   * configured SANDBOX_NET_ALLOWED_PORTS but no entry parsed; the alternative
   * is falling back to the 80,443 default, which would widen a policy written
   * to narrow it. Startup refuses this configuration too. */
  denyAllPorts?: boolean;
}

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOW: PolicyVerdict = { allowed: true };
function deny(reason: string): PolicyVerdict {
  return { allowed: false, reason };
}

/* A hostname long enough to be a DNS wire-format violation, or one carrying
 * anything outside the LDH set, is refused rather than normalized: every
 * lenient parser in this position has eventually turned into an SSRF bypass
 * (userinfo smuggling, embedded NUL, unicode homoglyph of a denied suffix). */
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/* Names that resolve to infrastructure by convention. The address gate below
 * already blocks the addresses these point at; the suffix list is a second,
 * independent layer that also covers a resolver configured to answer them with
 * a public address (split-horizon DNS pointing at an operator's edge). */
const DENIED_HOST_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.home.arpa',
  '.arpa',
  '.cluster.local',
  '.svc',
];
const DENIED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/**
 * Lowercase and validate a hostname or IP literal taken from a request target.
 * Returns null when the input is not something we are willing to resolve.
 *
 * Bracketed IPv6 literals ('[::1]') are unwrapped by the caller before this is
 * reached; a bare IPv6 literal is accepted here and handed to the address gate.
 */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return null;
  // Reject anything carrying request-target structure: userinfo, a port that
  // the caller failed to split off, a path, or a second authority.
  if (/[@/\\?#\s\0]/.test(host)) return null;
  // A single trailing dot is the DNS root and is legal in a URL; strip it so
  // 'evil.internal.' cannot slip past the suffix denylist.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return null;

  if (isIpLiteral(host)) return host;

  // Non-ASCII must be punycode-encoded by the client. Accepting raw unicode
  // here would mean comparing denylist entries against a string the resolver
  // will later fold differently.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.');
  // Single-label names ('intranet') resolve through the resolver's search
  // domain, which is exactly how internal hosts are reached. Public names
  // always carry a dot, so requiring one costs nothing.
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    if (!HOSTNAME_LABEL_RE.test(label)) return null;
  }
  return host;
}

/** True when the string is an IPv4 or IPv6 literal (not a name to resolve). */
export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/**
 * Host gate: suffix denylist plus the optional operator allowlist. Does not
 * look at addresses — checkAddress does that after resolution.
 */
export function checkHost(host: string, policy: NetPolicy): PolicyVerdict {
  if (DENIED_HOSTS.has(host)) return deny('host is denied by policy');
  for (const suffix of DENIED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return deny(`host suffix '${suffix}' is denied by policy`);
  }
  if (policy.denyAllHosts) return deny('SANDBOX_NET_ALLOWED_HOSTS contained no usable entries');
  if (policy.allowedHosts.length === 0) return ALLOW;
  for (const entry of policy.allowedHosts) {
    if (entry.startsWith('*.')) {
      const bare = entry.slice(2);
      if (host === bare || host.endsWith(`.${bare}`)) return ALLOW;
    } else if (host === entry) {
      return ALLOW;
    }
  }
  return deny('host is not in SANDBOX_NET_ALLOWED_HOSTS');
}

export function checkPort(port: number, policy: NetPolicy): PolicyVerdict {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return deny('invalid port');
  if (policy.denyAllPorts) return deny('SANDBOX_NET_ALLOWED_PORTS contained no usable entries');
  if (!policy.allowedPorts.includes(port)) return deny(`port ${port} is not in SANDBOX_NET_ALLOWED_PORTS`);
  return ALLOW;
}

/**
 * True when the host allowlist is what decides access, rather than the address
 * gate alone.
 *
 * This decides how strict the CONNECT tunnel check is, NOT whether it runs.
 * The SNI is always checked against the host gate when the client sends one,
 * because the infrastructure denylist applies with or without an allowlist —
 * a split-horizon name like admin.internal can resolve to the same public edge
 * as an ordinary site, and CONNECT to the ordinary name with the denied name in
 * the SNI would otherwise reach it.
 *
 * What this flag changes is the treatment of a tunnel with NO name in it. With
 * an allowlist the authority is the boundary, so a tunnel that cannot be bound
 * to it (no SNI, or not TLS at all) is refused. Without one the destination was
 * already settled by the address gate and there is no name to smuggle, so the
 * tunnel stays opaque and carries any protocol.
 */
export function hostAllowlistInForce(policy: NetPolicy): boolean {
  return policy.denyAllHosts === true || policy.allowedHosts.length > 0;
}

/* ── TLS ClientHello inspection ───────────────────────────────────────────
 *
 * Read-only: the proxy never terminates TLS and never rewrites a byte. All
 * this does is read the SNI out of the first handshake record so checkHost can
 * be applied to the name the client actually asks the server for. Pure and
 * incremental so it is testable without a socket.
 */

export type ClientHelloVerdict =
  | { status: 'need-more' }
  | { status: 'not-tls' }
  | { status: 'malformed' }
  | { status: 'ok'; sni: string | null };

/** Bytes of ClientHello we are willing to buffer before giving up. A real one
 * is well under 4 KiB even with a long ALPN list and post-quantum key shares. */
export const MAX_CLIENT_HELLO_BYTES = 16640;

function readUint24(buf: Buffer, offset: number): number {
  return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
}

/**
 * Parse the SNI out of a buffered TLS ClientHello.
 *
 * Returns 'need-more' while the record is incomplete, 'not-tls' when the first
 * bytes cannot be a TLS handshake record, 'malformed' when they claim to be one
 * but do not parse, and otherwise the server name (null when the client sent no
 * SNI extension, which is legitimate for an IP-literal target).
 */
export function inspectClientHelloSni(data: Buffer): ClientHelloVerdict {
  // record: type(1) legacy_version(2) length(2)
  if (data.length < 5) {
    // A handshake record always starts 0x16 0x03; reject early rather than
    // buffering an unbounded non-TLS stream waiting for a header.
    if (data.length >= 1 && data[0] !== 0x16) return { status: 'not-tls' };
    if (data.length >= 2 && data[1] !== 0x03) return { status: 'not-tls' };
    return { status: 'need-more' };
  }
  if (data[0] !== 0x16 || data[1] !== 0x03) return { status: 'not-tls' };

  const recordLength = data.readUInt16BE(3);
  if (recordLength === 0 || recordLength > MAX_CLIENT_HELLO_BYTES) return { status: 'malformed' };
  if (data.length < 5 + recordLength) return { status: 'need-more' };

  const body = data.subarray(5, 5 + recordLength);
  // handshake: msg_type(1) length(3)
  if (body.length < 4 || body[0] !== 0x01) return { status: 'malformed' };
  const handshakeLength = readUint24(body, 1);
  /* A ClientHello split across several records is legal but never produced by
   * a real client, and following it would mean reassembling handshake messages
   * here. Refuse rather than guess. */
  if (body.length < 4 + handshakeLength) return { status: 'malformed' };

  let p = 4;
  const hello = body.subarray(0, 4 + handshakeLength);
  const need = (n: number): boolean => p + n <= hello.length;

  if (!need(2 + 32)) return { status: 'malformed' };
  p += 2 + 32; // legacy_version, random

  if (!need(1)) return { status: 'malformed' };
  const sessionIdLength = hello[p];
  p += 1;
  if (!need(sessionIdLength)) return { status: 'malformed' };
  p += sessionIdLength;

  if (!need(2)) return { status: 'malformed' };
  const cipherSuitesLength = hello.readUInt16BE(p);
  p += 2;
  if (!need(cipherSuitesLength)) return { status: 'malformed' };
  p += cipherSuitesLength;

  if (!need(1)) return { status: 'malformed' };
  const compressionLength = hello[p];
  p += 1;
  if (!need(compressionLength)) return { status: 'malformed' };
  p += compressionLength;

  // No extensions at all: legal, and means no SNI.
  if (p === hello.length) return { status: 'ok', sni: null };
  if (!need(2)) return { status: 'malformed' };
  const extensionsLength = hello.readUInt16BE(p);
  p += 2;
  if (!need(extensionsLength)) return { status: 'malformed' };
  const end = p + extensionsLength;

  while (p + 4 <= end) {
    const type = hello.readUInt16BE(p);
    const length = hello.readUInt16BE(p + 2);
    p += 4;
    if (p + length > end) return { status: 'malformed' };
    if (type !== 0x0000) {
      p += length;
      continue;
    }
    // server_name_list: length(2) then entries of name_type(1) length(2) name
    const ext = hello.subarray(p, p + length);
    if (ext.length < 2) return { status: 'malformed' };
    const listLength = ext.readUInt16BE(0);
    if (listLength + 2 > ext.length) return { status: 'malformed' };
    let q = 2;
    while (q + 3 <= 2 + listLength) {
      const nameType = ext[q];
      const nameLength = ext.readUInt16BE(q + 1);
      q += 3;
      if (q + nameLength > 2 + listLength) return { status: 'malformed' };
      // 0 = host_name; it is the only type ever assigned.
      if (nameType === 0) {
        return { status: 'ok', sni: ext.subarray(q, q + nameLength).toString('latin1') };
      }
      q += nameLength;
    }
    return { status: 'ok', sni: null };
  }
  return { status: 'ok', sni: null };
}

/**
 * Decide whether a CONNECT tunnel authorized for `authority` may carry a
 * ClientHello asking for `sni`.
 *
 * The name has to survive the same host gate the authority did — an allowlisted
 * CONNECT target is not a licence to reach every other name the server hosts.
 */
export function checkTunnelSni(sni: string | null, authority: string, policy: NetPolicy): PolicyVerdict {
  if (sni === null) {
    // No SNI is only expected when the client is talking to an address, not a
    // name. Against a named authority it would leave the tunnel unbound.
    if (isIpLiteral(authority)) return ALLOW;
    /* With no allowlist there is no name to smuggle: the destination was
     * already settled by the address gate, and an absent SNI cannot reach a
     * denied name. Requiring one here would break every non-TLS CONNECT in the
     * default configuration for no gain. */
    if (!hostAllowlistInForce(policy)) return ALLOW;
    return deny('CONNECT tunnel carries no TLS SNI to bind it to the approved host');
  }
  const normalized = normalizeHost(sni);
  if (normalized === null) return deny('CONNECT tunnel sent an invalid TLS SNI');
  if (normalized === authority) return ALLOW;
  const verdict = checkHost(normalized, policy);
  if (!verdict.allowed) return deny(`CONNECT tunnel SNI '${normalized}' is not allowed: ${verdict.reason}`);
  return ALLOW;
}

/**
 * Address gate. Returns a denial reason for anything that is not publicly
 * routable, and null for an address the sandbox may reach.
 *
 * Callers MUST apply this to every address the resolver returned, not just the
 * one they intend to use: a name answering with both a public and a private
 * address is a split-horizon or rebinding setup, and picking the public one
 * would still let untrusted code confirm the private one exists.
 */
export function blockedAddressReason(ip: string): string | null {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return blockedIpv4Reason(v4);

  const v6 = parseIpv6(ip);
  if (v6 === null) return 'unparseable address';

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry a v4 address
  // in the low 32 bits and reach v4 destinations. Judge them as v4 so
  // ::ffff:127.0.0.1 cannot walk past the v4 loopback rule.
  const mapped = embeddedIpv4(v6);
  if (mapped !== null) return blockedIpv4Reason(mapped);

  return blockedIpv6Reason(v6);
}

/**
 * Post-connect check. `remote` is the peer address the kernel reports for an
 * established socket; it must equal the address policy approved. This closes
 * the window where a resolver answer changes between the check and the
 * connect, and catches a connect() that landed somewhere unexpected.
 */
export function verifyPinnedAddress(
  remote: string | undefined,
  pinned: string,
  screen: (ip: string) => string | null = blockedAddressReason,
): PolicyVerdict {
  if (!remote) return deny('upstream socket has no peer address');
  const a = canonicalizeAddress(remote);
  const b = canonicalizeAddress(pinned);
  if (a === null || b === null) return deny('unparseable peer address');
  if (a !== b) return deny('upstream peer address does not match the approved address');
  // Belt and braces: re-run the address gate on what we actually reached.
  const blocked = screen(remote);
  if (blocked !== null) return deny(`upstream peer address is blocked: ${blocked}`);
  return ALLOW;
}

/**
 * Canonical form for comparing two textual addresses. Node reports IPv4 peers
 * of a v6 socket as '::ffff:1.2.3.4', so compare on the numeric value rather
 * than the string.
 */
export function canonicalizeAddress(ip: string): string | null {
  const trimmed = ip.trim().toLowerCase().replace(/%.*$/, ''); // drop zone id
  const v4 = parseIpv4(trimmed);
  if (v4 !== null) return `v4:${v4 >>> 0}`;
  const v6 = parseIpv6(trimmed);
  if (v6 === null) return null;
  const mapped = embeddedIpv4(v6);
  if (mapped !== null) return `v4:${mapped >>> 0}`;
  return `v6:${v6.map(h => h.toString(16)).join(':')}`;
}

/* ── IPv4 ─────────────────────────────────────────────────────────────── */

/** Strict dotted-quad only. Rejects the octal/hex/short forms ('0x7f.1',
 * '127.1', '2130706433') that inet_aton accepts — those are the classic way to
 * spell a loopback address past a naive filter. */
export function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || !/^[0-9]+$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null; // no leading zeros (octal ambiguity)
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

interface Cidr4 { base: number; bits: number; reason: string }

function cidr4(text: string, reason: string): Cidr4 {
  const [addr, len] = text.split('/');
  const base = parseIpv4(addr);
  if (base === null) throw new Error(`bad CIDR in table: ${text}`);
  return { base, bits: Number(len), reason };
}

/* Every IPv4 range that is not globally reachable, per IANA's special-purpose
 * registry, plus the ranges that are routable but never a legitimate target
 * for sandboxed code. */
const BLOCKED_V4: Cidr4[] = [
  cidr4('0.0.0.0/8', 'this-network'),
  cidr4('10.0.0.0/8', 'private (RFC1918)'),
  cidr4('100.64.0.0/10', 'carrier-grade NAT'),
  cidr4('127.0.0.0/8', 'loopback'),
  cidr4('169.254.0.0/16', 'link-local / cloud metadata'),
  cidr4('172.16.0.0/12', 'private (RFC1918)'),
  cidr4('192.0.0.0/24', 'IETF protocol assignments'),
  cidr4('192.0.2.0/24', 'documentation (TEST-NET-1)'),
  cidr4('192.31.196.0/24', 'AS112'),
  cidr4('192.52.193.0/24', 'AMT'),
  cidr4('192.88.99.0/24', '6to4 relay anycast'),
  cidr4('192.168.0.0/16', 'private (RFC1918)'),
  cidr4('192.175.48.0/24', 'AS112 direct delegation'),
  cidr4('198.18.0.0/15', 'benchmarking'),
  cidr4('198.51.100.0/24', 'documentation (TEST-NET-2)'),
  cidr4('203.0.113.0/24', 'documentation (TEST-NET-3)'),
  cidr4('224.0.0.0/4', 'multicast'),
  cidr4('240.0.0.0/4', 'reserved / broadcast'),
];

function blockedIpv4Reason(addr: number): string | null {
  for (const { base, bits, reason } of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((addr & mask) >>> 0) === ((base & mask) >>> 0)) return reason;
  }
  return null;
}

/* ── IPv6 ─────────────────────────────────────────────────────────────── */

/** Returns 8 hextets, or null. Accepts '::' compression and a trailing
 * dotted-quad ('::ffff:1.2.3.4'); rejects everything else. */
export function parseIpv6(value: string): number[] | null {
  let text = value;
  if (text.includes('%')) text = text.slice(0, text.indexOf('%'));
  if (text.length === 0 || !text.includes(':')) return null;
  if (/[^0-9a-f:.]/.test(text)) return null;

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const afterLastColon = text.slice(lastColon + 1);
  if (afterLastColon.includes('.')) {
    const v4 = parseIpv4(afterLastColon);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1) + '0';
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null; // at most one '::'

  const toHextets = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const out: number[] = [];
    for (const part of segment.split(':')) {
      // parseInt would stop at a '.' and silently accept '1.2' as 0x1, so
      // require the whole hextet to be hex digits.
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  let head: number[];
  let rest: number[];
  if (doubleColon === -1) {
    const all = toHextets(text);
    if (all === null) return null;
    head = all;
    rest = [];
  } else {
    const left = toHextets(text.slice(0, doubleColon));
    const right = toHextets(text.slice(doubleColon + 2));
    if (left === null || right === null) return null;
    head = left;
    rest = right;
  }

  // The dotted-quad tail replaced its placeholder hextet; drop it and append
  // the two hextets it expands to.
  const placeholderCount = tail.length > 0 ? 1 : 0;
  const explicit = [...head, ...rest];
  const total = explicit.length - placeholderCount + tail.length;
  if (doubleColon === -1) {
    if (total !== 8) return null;
    const result = [...head.slice(0, head.length - placeholderCount), ...tail];
    return result.length === 8 ? result : null;
  }
  if (total > 8) return null;
  const rightPart = [...rest.slice(0, rest.length - placeholderCount), ...tail];
  const gap = 8 - head.length - rightPart.length;
  if (gap < 1) return null;
  return [...head, ...new Array(gap).fill(0), ...rightPart];
}

/** The v4 address embedded in a v4-mapped or NAT64 v6 address, else null. */
function embeddedIpv4(h: number[]): number | null {
  const zeroPrefix = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0;
  // ::ffff:a.b.c.d — IPv4-mapped
  if (zeroPrefix && h[4] === 0 && h[5] === 0xffff) return ((h[6] << 16) | h[7]) >>> 0;
  // ::a.b.c.d — IPv4-compatible (deprecated, still routed as v4 by some stacks)
  if (zeroPrefix && h[4] === 0 && h[5] === 0 && !(h[6] === 0 && h[7] <= 1)) {
    return ((h[6] << 16) | h[7]) >>> 0;
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b) return ((h[6] << 16) | h[7]) >>> 0;
  return null;
}

/**
 * IPv6 gate. Unlike the v4 table this cannot be a denylist: IANA has assigned
 * only a fraction of the v6 space, so "every range I remembered to name" leaves
 * the rest — fec0::/10 site-local, 3ffe::/16, and all of the unassigned
 * reserved blocks — reachable from the trusted runner. Global unicast is
 * exactly 2000::/3 (RFC 4291), so require that positively and carve out the
 * non-reachable prefixes inside it.
 */
function blockedIpv6Reason(h: number[]): string | null {
  const isZero = h.every(x => x === 0);
  if (isZero) return 'unspecified address';
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return 'loopback';
  }

  if ((h[0] & 0xe000) !== 0x2000) {
    // Name the ranges an operator is likely to see in a log; everything else
    // outside 2000::/3 is reserved or unassigned and denied on that basis.
    if ((h[0] & 0xfe00) === 0xfc00) return 'unique local (ULA)';
    if ((h[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((h[0] & 0xffc0) === 0xfec0) return 'site-local (deprecated RFC 3879)';
    if ((h[0] & 0xff00) === 0xff00) return 'multicast';
    if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return 'discard-only';
    return 'not global unicast (outside 2000::/3)';
  }

  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'documentation';
  // 2001::/32 Teredo and 2002::/16 6to4 tunnel to an operator-chosen v4
  // endpoint; the embedded address is not in the low bits, so refuse the
  // whole prefix rather than trying to extract it.
  if (h[0] === 0x2001 && h[1] === 0x0000) return 'Teredo tunnel';
  if (h[0] === 0x2002) return '6to4 tunnel';
  if (h[0] === 0x2001 && h[1] <= 0x01ff) return 'IETF protocol assignment';
  // 3fff::/20, documentation since RFC 9637. Inside 2000::/3, so the positive
  // gate above lets it through and it needs naming here.
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return 'documentation';
  return null;
}

/* ── Config parsing ───────────────────────────────────────────────────── */

export interface AllowedHostsConfig {
  hosts: string[];
  /** The operator configured an allowlist, but not one entry survived
   * validation. See {@link NetPolicy.denyAllHosts}. */
  denyAll: boolean;
}

/**
 * Parse SANDBOX_NET_ALLOWED_HOSTS. '*' (or an empty value) means "no host
 * allowlist"; entries that are not a valid host or '*.host' pattern are dropped
 * rather than silently widening the policy.
 *
 * An empty result is ambiguous on its own — it is what both "no allowlist
 * configured" and "every entry was a typo" produce — so the caller is told
 * which happened. A restrictive policy written as 'api.example.com/v1' parses
 * to nothing, and treating that as "no allowlist" would turn one typo into
 * unrestricted egress to every public host.
 */
export function parseAllowedHostsConfig(raw: string | undefined): AllowedHostsConfig {
  if (!raw) return { hosts: [], denyAll: false };
  const out: string[] = [];
  let sawEntry = false;
  for (const piece of raw.split(',')) {
    const entry = piece.trim().toLowerCase();
    if (entry.length === 0) continue;
    sawEntry = true;
    if (entry === '*') return { hosts: [], denyAll: false };
    if (entry.startsWith('*.')) {
      if (normalizeHost(entry.slice(2)) !== null) out.push(entry);
      continue;
    }
    const normalized = normalizeHost(entry);
    if (normalized !== null) out.push(normalized);
  }
  return { hosts: out, denyAll: sawEntry && out.length === 0 };
}

/** The host list alone. Prefer {@link parseAllowedHostsConfig} where the
 * "configured but unusable" case has to be distinguished. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return parseAllowedHostsConfig(raw).hosts;
}

export interface AllowedPortsConfig {
  ports: number[];
  /** The operator configured a port list, but not one entry parsed. */
  denyAll: boolean;
}

/**
 * Parse SANDBOX_NET_ALLOWED_PORTS.
 *
 * Absent means the caller's default. Configured-but-unusable ('443/tcp',
 * 'https') is NOT the default: falling back there would open the standard ports
 * on the strength of a typo in a policy meant to narrow them. Reported the same
 * way {@link parseAllowedHostsConfig} reports it, and refused at startup.
 */
export function parseAllowedPortsConfig(
  raw: string | undefined,
  fallback: number[],
): AllowedPortsConfig {
  if (!raw) return { ports: [...fallback], denyAll: false };
  const out: number[] = [];
  let sawEntry = false;
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (entry.length === 0) continue;
    sawEntry = true;
    if (!/^[0-9]{1,5}$/.test(entry)) continue;
    const port = Number(entry);
    if (port >= 1 && port <= 65535 && !out.includes(port)) out.push(port);
  }
  if (out.length > 0) return { ports: out, denyAll: false };
  if (sawEntry) return { ports: [], denyAll: true };
  return { ports: [...fallback], denyAll: false };
}

/** The port list alone. Prefer {@link parseAllowedPortsConfig} where the
 * "configured but unusable" case has to be distinguished. */
export function parseAllowedPorts(raw: string | undefined, fallback: number[]): number[] {
  const parsed = parseAllowedPortsConfig(raw, fallback);
  return parsed.denyAll ? [] : parsed.ports;
}
