import { describe, expect, test } from 'bun:test';
import {
  blockedAddressReason,
  canonicalizeAddress,
  checkHost,
  checkPort,
  isIpLiteral,
  normalizeHost,
  checkTunnelSni,
  hostAllowlistInForce,
  inspectClientHelloSni,
  parseAllowedHosts,
  parseAllowedHostsConfig,
  parseAllowedPorts,
  parseAllowedPortsConfig,
  parseIpv4,
  parseIpv6,
  verifyPinnedAddress,
  type NetPolicy,
} from './net-policy';

const OPEN: NetPolicy = { allowedHosts: [], allowedPorts: [80, 443] };
const LISTED: NetPolicy = { allowedHosts: ['api.github.com', '*.pypi.org'], allowedPorts: [443] };

describe('normalizeHost', () => {
  test('lowercases and strips the root dot', () => {
    expect(normalizeHost('  API.GitHub.COM.  ')).toBe('api.github.com');
  });

  test('accepts IP literals in both families', () => {
    expect(normalizeHost('93.184.216.34')).toBe('93.184.216.34');
    expect(normalizeHost('2606:2800:220:1:248:1893:25c8:1946')).toBe('2606:2800:220:1:248:1893:25c8:1946');
  });

  test('rejects request-target structure', () => {
    for (const bad of [
      'user@evil.com',
      'evil.com/path',
      'evil.com\\path',
      'evil.com?x=1',
      'evil.com#frag',
      'evil .com',
      'evil.com\0',
    ]) {
      expect(normalizeHost(bad)).toBeNull();
    }
  });

  test('rejects single-label names that would use the resolver search domain', () => {
    expect(normalizeHost('intranet')).toBeNull();
  });

  test('rejects non-ASCII, oversized labels, and empty labels', () => {
    expect(normalizeHost('exämple.com')).toBeNull();
    expect(normalizeHost(`${'a'.repeat(64)}.com`)).toBeNull();
    expect(normalizeHost('a..com')).toBeNull();
    expect(normalizeHost(`${'a.'.repeat(200)}com`)).toBeNull();
  });

  test('rejects a hyphen at a label boundary', () => {
    expect(normalizeHost('-evil.com')).toBeNull();
    expect(normalizeHost('evil-.com')).toBeNull();
  });
});

describe('checkHost', () => {
  test('allows anything syntactically valid with no allowlist', () => {
    expect(checkHost('example.com', OPEN).allowed).toBe(true);
  });

  test('denies infrastructure names even with no allowlist', () => {
    expect(checkHost('metadata.google.internal', OPEN).allowed).toBe(false);
    expect(checkHost('localhost', OPEN).allowed).toBe(false);
    expect(checkHost('anything.internal', OPEN).allowed).toBe(false);
    expect(checkHost('svc.cluster.local', OPEN).allowed).toBe(false);
    expect(checkHost('printer.local', OPEN).allowed).toBe(false);
  });

  test('enforces the allowlist exactly', () => {
    expect(checkHost('api.github.com', LISTED).allowed).toBe(true);
    expect(checkHost('pypi.org', LISTED).allowed).toBe(true);
    expect(checkHost('files.pypi.org', LISTED).allowed).toBe(true);
    expect(checkHost('github.com', LISTED).allowed).toBe(false);
    expect(checkHost('api.github.com.evil.net', LISTED).allowed).toBe(false);
    expect(checkHost('evilpypi.org', LISTED).allowed).toBe(false);
  });
});

describe('checkPort', () => {
  test('allows listed ports only', () => {
    expect(checkPort(443, OPEN).allowed).toBe(true);
    expect(checkPort(80, OPEN).allowed).toBe(true);
    expect(checkPort(25, OPEN).allowed).toBe(false);
    expect(checkPort(22, OPEN).allowed).toBe(false);
    expect(checkPort(6379, OPEN).allowed).toBe(false);
  });

  test('rejects out-of-range and non-integer ports', () => {
    expect(checkPort(0, OPEN).allowed).toBe(false);
    expect(checkPort(65536, OPEN).allowed).toBe(false);
    expect(checkPort(4.5, OPEN).allowed).toBe(false);
    expect(checkPort(NaN, OPEN).allowed).toBe(false);
  });
});

describe('parseIpv4', () => {
  test('accepts dotted quads', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
  });

  test('rejects the inet_aton shorthands used to smuggle loopback', () => {
    for (const bad of ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '127.0.0.01', '1.2.3.4.5', '1.2.3', '1.2.3.256', '']) {
      expect(parseIpv4(bad)).toBeNull();
    }
  });
});

describe('parseIpv6', () => {
  test('expands compressed forms to eight hextets', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  test('handles a trailing dotted quad', () => {
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6('64:ff9b::10.0.0.1')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0a00, 1]);
  });

  test('rejects malformed input', () => {
    for (const bad of ['1::2::3', 'gggg::1', '1.2.3.4', '', ':::', '12345::1', '1.2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9']) {
      expect(parseIpv6(bad)).toBeNull();
    }
  });
});

describe('blockedAddressReason', () => {
  test('blocks every private and special-purpose IPv4 range', () => {
    const blocked = [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.1.2.3',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1',
      '192.0.2.5', '192.88.99.1', '192.168.1.1', '198.18.0.1',
      '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.1.1.1', '255.255.255.255',
    ];
    for (const ip of blocked) {
      expect(blockedAddressReason(ip)).not.toBeNull();
    }
  });

  test('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '151.101.1.63', '172.32.0.1', '172.15.255.255']) {
      expect(blockedAddressReason(ip)).toBeNull();
    }
  });

  test('blocks IPv6 loopback, ULA, link-local, multicast and tunnels', () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:c0a8:0101::1', '100::1']) {
      expect(blockedAddressReason(ip)).not.toBeNull();
    }
  });

  test('allows ordinary public IPv6', () => {
    expect(blockedAddressReason('2606:4700:4700::1111')).toBeNull();
    expect(blockedAddressReason('2a00:1450:4001:81f::200e')).toBeNull();
  });

  test('judges v4-mapped and NAT64 addresses by their embedded v4', () => {
    expect(blockedAddressReason('::ffff:127.0.0.1')).not.toBeNull();
    expect(blockedAddressReason('::ffff:169.254.169.254')).not.toBeNull();
    expect(blockedAddressReason('64:ff9b::10.0.0.1')).not.toBeNull();
    expect(blockedAddressReason('::ffff:8.8.8.8')).toBeNull();
  });

  test('rejects anything it cannot parse', () => {
    expect(blockedAddressReason('not-an-ip')).toBe('unparseable address');
    expect(blockedAddressReason('')).toBe('unparseable address');
  });
});

describe('verifyPinnedAddress', () => {
  test('accepts the same address in a different textual form', () => {
    expect(verifyPinnedAddress('::ffff:93.184.216.34', '93.184.216.34').allowed).toBe(true);
    expect(verifyPinnedAddress('93.184.216.34', '93.184.216.34').allowed).toBe(true);
  });

  test('rejects a peer that is not the approved address', () => {
    expect(verifyPinnedAddress('93.184.216.35', '93.184.216.34').allowed).toBe(false);
    expect(verifyPinnedAddress(undefined, '93.184.216.34').allowed).toBe(false);
  });

  test('rejects a peer that became private between check and connect', () => {
    expect(verifyPinnedAddress('127.0.0.1', '127.0.0.1').allowed).toBe(false);
  });
});

describe('canonicalizeAddress', () => {
  test('folds v4-mapped v6 onto v4 and drops the zone id', () => {
    expect(canonicalizeAddress('::ffff:1.2.3.4')).toBe(canonicalizeAddress('1.2.3.4'));
    expect(canonicalizeAddress('fe80::1%eth0')).toBe(canonicalizeAddress('fe80::1'));
  });
});

describe('config parsing', () => {
  test('parseAllowedHosts keeps valid entries and treats * as no allowlist', () => {
    expect(parseAllowedHosts('api.github.com, *.pypi.org ')).toEqual(['api.github.com', '*.pypi.org']);
    expect(parseAllowedHosts('*')).toEqual([]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('')).toEqual([]);
  });

  test('parseAllowedHosts drops garbage instead of widening the policy', () => {
    expect(parseAllowedHosts('evil.com/path, ok.example.com')).toEqual(['ok.example.com']);
    expect(parseAllowedHosts('nonsense')).toEqual([]);
  });

  test('parseAllowedPorts uses the default only when nothing was configured', () => {
    expect(parseAllowedPorts('443, 80', [80])).toEqual([443, 80]);
    expect(parseAllowedPorts(undefined, [80, 443])).toEqual([80, 443]);
    expect(parseAllowedPorts('', [80, 443])).toEqual([80, 443]);
    /* Configured-but-unusable is NOT the default: falling back would open 80
     * and 443 on the strength of a typo in a policy written to narrow them. */
    expect(parseAllowedPorts('abc', [80, 443])).toEqual([]);
    expect(parseAllowedPorts('0, 70000', [443])).toEqual([]);
  });

  test('parseAllowedPortsConfig reports a port list that parsed to nothing', () => {
    expect(parseAllowedPortsConfig('443/tcp', [80, 443])).toEqual({ ports: [], denyAll: true });
    expect(parseAllowedPortsConfig('https', [80, 443])).toEqual({ ports: [], denyAll: true });
    expect(parseAllowedPortsConfig(undefined, [80, 443])).toEqual({ ports: [80, 443], denyAll: false });
    expect(parseAllowedPortsConfig('  ', [80, 443])).toEqual({ ports: [80, 443], denyAll: false });
    expect(parseAllowedPortsConfig('8443, junk', [80])).toEqual({ ports: [8443], denyAll: false });
  });

  test('checkPort denies everything when the port list parsed to nothing', () => {
    const broken: NetPolicy = { allowedHosts: [], allowedPorts: [], denyAllPorts: true };
    expect(checkPort(443, broken).allowed).toBe(false);
    expect(checkPort(80, broken).allowed).toBe(false);
  });
});

describe('isIpLiteral', () => {
  test('distinguishes literals from names', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('an allowlist that parses to nothing', () => {
  test('is reported as deny-all rather than as no allowlist', () => {
    expect(parseAllowedHostsConfig('api.example.com/v1')).toEqual({ hosts: [], denyAll: true });
    expect(parseAllowedHostsConfig('nonsense, also nonsense')).toEqual({ hosts: [], denyAll: true });
    // Deliberately open, and genuinely unset, stay open.
    expect(parseAllowedHostsConfig('*')).toEqual({ hosts: [], denyAll: false });
    expect(parseAllowedHostsConfig(undefined)).toEqual({ hosts: [], denyAll: false });
    expect(parseAllowedHostsConfig('   ')).toEqual({ hosts: [], denyAll: false });
    // One good entry is a narrow policy, not an unusable one.
    expect(parseAllowedHostsConfig('bad/entry, ok.example.com'))
      .toEqual({ hosts: ['ok.example.com'], denyAll: false });
  });

  test('denies every host at runtime instead of allowing all public ones', () => {
    const broken: NetPolicy = { allowedHosts: [], denyAllHosts: true, allowedPorts: [443] };
    expect(checkHost('example.com', broken).allowed).toBe(false);
    expect(checkHost('api.github.com', broken).allowed).toBe(false);
    // The same empty list without the flag is the documented "no allowlist".
    expect(checkHost('example.com', OPEN).allowed).toBe(true);
  });

  test('counts as an allowlist being in force', () => {
    expect(hostAllowlistInForce(OPEN)).toBe(false);
    expect(hostAllowlistInForce(LISTED)).toBe(true);
    expect(hostAllowlistInForce({ allowedHosts: [], denyAllHosts: true, allowedPorts: [443] })).toBe(true);
  });
});

describe('IPv6 is gated on global unicast, not a denylist', () => {
  test('refuses reserved space a prefix list would miss', () => {
    // The one that motivated this: site-local still routes on legacy networks.
    expect(blockedAddressReason('fec0::1')).not.toBeNull();
    for (const ip of ['4000::1', '8000::1', 'c000::1', '0200::1', '1000::1']) {
      expect(blockedAddressReason(ip)).not.toBeNull();
    }
  });

  test('still allows real global unicast', () => {
    expect(blockedAddressReason('2606:4700:4700::1111')).toBeNull();
    expect(blockedAddressReason('2a00:1450:4001:81f::200e')).toBeNull();
    // 3ffe::/16 was the 6bone and is ordinary global unicast again.
    expect(blockedAddressReason('3ffe::1')).toBeNull();
    expect(blockedAddressReason('3000::1')).toBeNull();
  });

  test('keeps refusing the carve-outs inside 2000::/3', () => {
    for (const ip of ['2001:db8::1', '2001::1', '2002:c0a8:0101::1', '2001:1::1', '3fff::1']) {
      expect(blockedAddressReason(ip)).not.toBeNull();
    }
  });
});

/** Minimal well-formed ClientHello carrying `sni` (or none when null). */
function clientHello(sni: string | null): Buffer {
  const extensions: Buffer[] = [];
  if (sni !== null) {
    const name = Buffer.from(sni, 'latin1');
    const entry = Buffer.concat([Buffer.from([0x00]), sizeOf(name.length), name]);
    const list = Buffer.concat([sizeOf(entry.length), entry]);
    extensions.push(Buffer.concat([Buffer.from([0x00, 0x00]), sizeOf(list.length), list]));
  }
  const extensionBlock = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),          // legacy_version
    Buffer.alloc(32),                    // random
    Buffer.from([0x00]),                 // session_id (empty)
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher_suites
    Buffer.from([0x01, 0x00]),           // compression_methods
    sizeOf(extensionBlock.length),
    extensionBlock,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), sizeOf(handshake.length), handshake]);
}

function sizeOf(n: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(n);
  return out;
}

describe('inspectClientHelloSni', () => {
  test('reads the server name out of a ClientHello', () => {
    expect(inspectClientHelloSni(clientHello('api.github.com')))
      .toEqual({ status: 'ok', sni: 'api.github.com' });
  });

  test('reports no SNI when the extension is absent', () => {
    expect(inspectClientHelloSni(clientHello(null))).toEqual({ status: 'ok', sni: null });
  });

  test('asks for more while the record is incomplete', () => {
    const hello = clientHello('api.github.com');
    expect(inspectClientHelloSni(hello.subarray(0, 3))).toEqual({ status: 'need-more' });
    expect(inspectClientHelloSni(hello.subarray(0, hello.length - 1))).toEqual({ status: 'need-more' });
  });

  test('rejects bytes that are not a TLS handshake without buffering them', () => {
    expect(inspectClientHelloSni(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ status: 'not-tls' });
    expect(inspectClientHelloSni(Buffer.from([0x16]))).toEqual({ status: 'need-more' });
    expect(inspectClientHelloSni(Buffer.from([0x17, 0x03]))).toEqual({ status: 'not-tls' });
  });

  test('reports a truncated or lying record as malformed rather than guessing', () => {
    const hello = clientHello('api.github.com');
    const lying = Buffer.from(hello);
    lying.writeUInt16BE(4, 3); // record claims 4 bytes of handshake
    expect(inspectClientHelloSni(lying).status).toBe('malformed');
  });
});

describe('checkTunnelSni', () => {
  test('lets the tunnel through for the name it was authorized for', () => {
    expect(checkTunnelSni('api.github.com', 'api.github.com', LISTED).allowed).toBe(true);
  });

  test('refuses a different name sharing the approved address', () => {
    // The bypass: CONNECT to an allowlisted host on a CDN, then ask the server
    // for a co-hosted name it never allowed.
    const verdict = checkTunnelSni('evil.example.com', 'api.github.com', LISTED);
    expect(verdict.allowed).toBe(false);
  });

  test('allows another name that the allowlist itself covers', () => {
    expect(checkTunnelSni('files.pypi.org', 'api.github.com', LISTED).allowed).toBe(true);
  });

  test('requires SNI against a named authority and tolerates its absence for a literal', () => {
    expect(checkTunnelSni(null, 'api.github.com', LISTED).allowed).toBe(false);
    expect(checkTunnelSni(null, '93.184.216.34', LISTED).allowed).toBe(true);
  });

  test('refuses an SNI that is not a usable hostname', () => {
    expect(checkTunnelSni('evil.com/path', 'api.github.com', LISTED).allowed).toBe(false);
    expect(checkTunnelSni('', 'api.github.com', LISTED).allowed).toBe(false);
  });
});

describe('checkTunnelSni without an allowlist', () => {
  test('still enforces the infrastructure denylist', () => {
    // The denylist is part of the host gate with or without an allowlist.
    expect(checkTunnelSni('admin.internal', 'example.com', OPEN).allowed).toBe(false);
    expect(checkTunnelSni('metadata.google.internal', 'example.com', OPEN).allowed).toBe(false);
    expect(checkTunnelSni('foo.cluster.local', 'example.com', OPEN).allowed).toBe(false);
  });

  test('allows any other public name, as the address gate already did', () => {
    expect(checkTunnelSni('other.example.com', 'example.com', OPEN).allowed).toBe(true);
  });

  test('tolerates a tunnel with no name in it', () => {
    /* Nothing to smuggle: the destination was settled by the address gate, and
     * requiring an SNI here would break every non-TLS CONNECT by default. */
    expect(checkTunnelSni(null, 'example.com', OPEN).allowed).toBe(true);
    // With an allowlist the authority is the boundary, so it must be bindable.
    expect(checkTunnelSni(null, 'api.github.com', LISTED).allowed).toBe(false);
  });
});

