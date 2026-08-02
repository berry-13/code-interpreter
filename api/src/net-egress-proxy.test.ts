import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildUpstreamHead, createNetEgressProxy, parseRequestHead, RequestRejected } from './net-egress-proxy';
import type { NetPolicy } from './net-policy';

const OPEN: NetPolicy = { allowedHosts: [], allowedPorts: [80, 443] };

function rejection(head: string, policy: NetPolicy = OPEN): { status: number; reason: string } {
  try {
    parseRequestHead(head, policy);
  } catch (error) {
    if (error instanceof RequestRejected) return { status: error.status, reason: error.reason };
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('parseRequestHead', () => {
  test('accepts an absolute-form request and rewrites it to origin form', () => {
    const parsed = parseRequestHead(
      'GET http://example.com/a/b?c=1 HTTP/1.1\r\nHost: example.com\r\nAccept: */*',
      OPEN,
    );
    expect(parsed.host).toBe('example.com');
    expect(parsed.port).toBe(80);
    expect(parsed.target).toBe('/a/b?c=1');
    expect(parsed.isConnect).toBe(false);
    expect(parsed.headers).toEqual([['Accept', '*/*']]);
  });

  test('accepts CONNECT with an explicit port', () => {
    const parsed = parseRequestHead('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443', OPEN);
    expect(parsed.isConnect).toBe(true);
    expect(parsed.port).toBe(443);
  });

  test('strips hop-by-hop and proxy headers', () => {
    const parsed = parseRequestHead(
      'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n' +
        'Proxy-Authorization: Basic x\r\nConnection: keep-alive\r\nKeep-Alive: 100\r\nX-Keep: yes',
      OPEN,
    );
    expect(parsed.headers).toEqual([['X-Keep', 'yes']]);
  });

  test('rejects smuggling shapes', () => {
    expect(rejection('GET http://example.com/ HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6').status).toBe(400);
    expect(rejection('POST http://example.com/ HTTP/1.1\r\nTransfer-Encoding: chunked').status).toBe(411);
    expect(rejection('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nHost: evil.com').status).toBe(400);
    expect(rejection('GET http://example.com/ HTTP/1.1\r\n X-Folded: continuation').status).toBe(400);
    expect(rejection('GET http://example.com/ HTTP/1.1\nHost: example.com').status).toBe(400);
    expect(rejection('GET http://example.com/ HTTP/1.1\r\nX-Bad\0Name: v').status).toBe(400);
  });

  test('rejects targets that are not absolute http:// or CONNECT', () => {
    expect(rejection('GET /path HTTP/1.1\r\nHost: example.com').status).toBe(400);
    expect(rejection('GET https://example.com/ HTTP/1.1\r\nHost: example.com').status).toBe(400);
    expect(rejection('GET http://user:pw@example.com/ HTTP/1.1\r\nHost: example.com').status).toBe(400);
    expect(rejection('GET file:///etc/passwd HTTP/1.1\r\nHost: x').status).toBe(400);
  });

  test('rejects unsupported methods, versions and upgrades', () => {
    expect(rejection('TRACE http://example.com/ HTTP/1.1\r\nHost: example.com').status).toBe(405);
    expect(rejection('GET http://example.com/ HTTP/2.0\r\nHost: example.com').status).toBe(505);
    expect(rejection('GET http://example.com/ HTTP/1.1\r\nUpgrade: websocket').status).toBe(400);
  });

  test('applies the host and port gates', () => {
    // NB: an IP literal like 169.254.169.254 passes the *host* gate and is
    // stopped by the address gate at connect time — see the e2e test below.
    // 'localhost' never even reaches the host gate: it is a single-label name,
    // which normalizeHost refuses outright (400, not 403).
    expect(rejection('GET http://localhost/ HTTP/1.1\r\nHost: x').status).toBe(400);
    expect(rejection('GET http://metadata.google.internal/ HTTP/1.1\r\nHost: x').status).toBe(403);
    expect(rejection('CONNECT internal.svc:443 HTTP/1.1\r\nHost: x').status).toBe(403);
    expect(rejection('CONNECT example.com:22 HTTP/1.1\r\nHost: x').status).toBe(403);
    expect(
      rejection('GET http://other.com/ HTTP/1.1\r\nHost: x', { allowedHosts: ['example.com'], allowedPorts: [80] }).status,
    ).toBe(403);
  });

  test('accepts an IPv6 literal authority in both forms', () => {
    expect(parseRequestHead('CONNECT [2606:4700::1111]:443 HTTP/1.1\r\nHost: x', OPEN).host)
      .toBe('2606:4700::1111');
    expect(parseRequestHead('GET http://[2606:4700::1111]/ HTTP/1.1\r\nHost: x', OPEN).port).toBe(80);
  });

  test('rejects a body on a method that must not carry one', () => {
    expect(rejection('GET http://example.com/ HTTP/1.1\r\nContent-Length: 10').status).toBe(400);
  });
});

/* ── End-to-end over a real unix socket ───────────────────────────────── */

const tempDirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close().catch(() => {});
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netproxy-'));
  tempDirs.push(dir);
  return path.join(dir, 's.sock');
}

/** An origin server on loopback. The proxy would normally refuse to reach it
 * (127.0.0.1 is blocked), so tests inject a lookup that maps a public-looking
 * name onto it and a connect that dials the real port — exercising the full
 * request path while keeping the address gate's own tests in net-policy. */
async function startOrigin(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function startProxy(originPort: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const sock = socketPath();
  const handle = await createNetEgressProxy({
    socketPath: sock,
    policy: OPEN,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: () => net.connect({ host: '127.0.0.1', port: originPort }),
    ...overrides,
  } as Parameters<typeof createNetEgressProxy>[0]);
  closers.push(handle.close);
  return sock;
}

/** A proxy whose address gate is neutralized so the data path can be driven
 * against a loopback origin. Everything else — parsing, framing, pinning,
 * budgets — is the production code path. Tests that assert the gate itself
 * deliberately do NOT use this. */
async function startDataPathProxy(originPort: number, overrides: Record<string, unknown> = {}): Promise<string> {
  return startProxy(originPort, {
    addressScreen: () => null,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    ...overrides,
  });
}

/** Speak proxy protocol over the unix socket and collect the raw response. */
function proxyRequest(sock: string, payload: string, opts: { keepOpenMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: sock });
    let data = '';
    const done = (): void => resolve(data);
    client.on('connect', () => client.write(payload));
    client.on('data', chunk => {
      data += chunk.toString('utf8');
      if (opts.keepOpenMs === undefined) return;
      setTimeout(() => {
        client.destroy();
        done();
      }, opts.keepOpenMs);
    });
    client.on('end', done);
    client.on('close', done);
    client.on('error', reject);
    setTimeout(() => {
      client.destroy();
      done();
    }, 5_000);
  });
}

describe('createNetEgressProxy', () => {
  test('proxies an allowed request and forwards a clean origin-form request', async () => {
    let seenUrl = '';
    let seenHost = '';
    let seenProxyHeader: string | undefined = 'unset';
    const origin = await startOrigin((req, res) => {
      seenUrl = req.url ?? '';
      seenHost = req.headers.host ?? '';
      seenProxyHeader = req.headers['proxy-authorization'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello from origin');
    });
    closers.push(origin.close);
    const sock = await startDataPathProxy(origin.port);

    const response = await proxyRequest(
      sock,
      'GET http://example.com/thing?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic secret\r\n\r\n',
    );

    expect(response).toContain('200 OK');
    expect(response).toContain('hello from origin');
    expect(seenUrl).toBe('/thing?q=1');
    expect(seenHost).toBe('example.com');
    expect(seenProxyHeader).toBeUndefined();
  });

  test('forwards a length-delimited body', async () => {
    let body = '';
    const origin = await startOrigin((req, res) => {
      req.on('data', c => (body += c.toString()));
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    closers.push(origin.close);
    const sock = await startDataPathProxy(origin.port);

    const response = await proxyRequest(
      sock,
      'POST http://example.com/upload HTTP/1.1\r\nHost: example.com\r\nContent-Length: 11\r\n\r\nhello world',
    );
    expect(response).toContain('200 OK');
    expect(body).toBe('hello world');
  });

  test('refuses a pipelined second request instead of forwarding it', async () => {
    let requests = 0;
    const origin = await startOrigin((_req, res) => {
      requests++;
      res.writeHead(200);
      res.end('ok');
    });
    closers.push(origin.close);
    const sock = await startDataPathProxy(origin.port);

    const response = await proxyRequest(
      sock,
      'GET http://example.com/first HTTP/1.1\r\nHost: example.com\r\n\r\n' +
        'GET http://evil.com/second HTTP/1.1\r\nHost: evil.com\r\n\r\n',
    );
    expect(response).toContain('400');
    expect(requests).toBe(0);
  });

  test('denies a blocked host with a 403 and never dials upstream', async () => {
    let dialed = false;
    const sock = await startProxy(1, {
      connect: () => {
        dialed = true;
        return net.connect({ path: '/nonexistent' });
      },
    });
    const response = await proxyRequest(sock, 'GET http://169.254.169.254/ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(response).toContain('403');
    expect(dialed).toBe(false);
  });

  test('denies when DNS resolves to a private address', async () => {
    let dialed = false;
    const sock = await startProxy(1, {
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      connect: () => {
        dialed = true;
        return net.connect({ path: '/nonexistent' });
      },
    });
    const response = await proxyRequest(sock, 'GET http://rebind.example.com/ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(response).toContain('403');
    expect(dialed).toBe(false);
  });

  test('denies when only one of several answers is private', async () => {
    const sock = await startProxy(1, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      connect: () => net.connect({ path: '/nonexistent' }),
    });
    const response = await proxyRequest(sock, 'GET http://split.example.com/ HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(response).toContain('403');
  });

  test('tears the connection down when the peer is not the approved address', async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200);
      res.end('should not be delivered');
    });
    closers.push(origin.close);
    // The gate approves 127.0.0.2 but the socket actually lands on 127.0.0.1;
    // only the post-connect peer check can catch that.
    const sock = await startDataPathProxy(origin.port, {
      lookup: async () => [{ address: '127.0.0.2', family: 4 }],
    });
    const response = await proxyRequest(sock, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    expect(response).toContain('502');
    expect(response).not.toContain('should not be delivered');
  });

  test('enforces the per-job request limit', async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    closers.push(origin.close);
    const sock = await startDataPathProxy(origin.port, { maxRequests: 1 });
    // The first request is allowed and consumes the whole budget; the second
    // must be refused before it can reach the origin.
    await proxyRequest(sock, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const second = await proxyRequest(sock, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    expect(second).toContain('429');
  });

  test('times out a client that never completes a request head', async () => {
    const sock = await startProxy(1, { headerTimeoutMs: 150 });
    const response = await proxyRequest(sock, 'GET http://example.com/ HTTP/1.1\r\nHost: exa');
    expect(response).toContain('408');
  });

  test('rejects an oversized request head', async () => {
    const sock = await startProxy(1, { maxRequestHeadBytes: 256 });
    const padding = 'x'.repeat(500);
    const response = await proxyRequest(
      sock,
      `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nX-Pad: ${padding}\r\n\r\n`,
    );
    expect(response).toContain('431');
  });

  test('creates the socket with 0600 so only the job UID can connect', async () => {
    const sock = await startProxy(1);
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
  });

  test('close() removes the socket file', async () => {
    const sock = socketPath();
    const handle = await createNetEgressProxy({ socketPath: sock, policy: OPEN });
    expect(fs.existsSync(sock)).toBe(true);
    await handle.close();
    expect(fs.existsSync(sock)).toBe(false);
  });
});


describe('buildUpstreamHead', () => {
  const WITH_8080: NetPolicy = { allowedHosts: [], allowedPorts: [80, 443, 8080] };
  function head(raw: string, policy: NetPolicy = OPEN): string {
    return buildUpstreamHead(parseRequestHead(raw, policy));
  }

  test('emits origin form with a forced Connection: close', () => {
    const out = head('GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nAccept: */*');
    expect(out.split('\r\n')[0]).toBe('GET /a?b=1 HTTP/1.1');
    expect(out).toContain('Host: example.com');
    expect(out).toContain('Accept: */*');
    expect(out).toContain('Connection: close');
    expect(out.endsWith('\r\n\r\n')).toBe(true);
  });

  test('does not leak proxy-only headers to the origin', () => {
    const out = head(
      'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n' +
        'Proxy-Authorization: Basic secret\r\nProxy-Connection: keep-alive',
    );
    expect(out.toLowerCase()).not.toContain('proxy-auth');
    expect(out.toLowerCase()).not.toContain('proxy-connection');
    expect(out.toLowerCase()).not.toContain('secret');
  });

  test('always frames a method that may carry a body', () => {
    expect(head('POST http://example.com/ HTTP/1.1\r\nHost: example.com')).toContain('Content-Length: 0');
    expect(head('POST http://example.com/ HTTP/1.1\r\nHost: example.com\r\nContent-Length: 7'))
      .toContain('Content-Length: 7');
    expect(head('GET http://example.com/ HTTP/1.1\r\nHost: example.com')).not.toContain('Content-Length');
  });

  test('brackets an IPv6 literal in the Host header', () => {
    const out = head('GET http://[2606:4700::1111]:8080/x HTTP/1.1\r\nHost: y', WITH_8080);
    expect(out).toContain('Host: [2606:4700::1111]:8080');
  });

  test('a non-default port appears in Host, port 80 does not', () => {
    expect(head('GET http://example.com:8080/ HTTP/1.1\r\nHost: y', WITH_8080)).toContain('Host: example.com:8080');
    expect(head('GET http://example.com/ HTTP/1.1\r\nHost: y')).toContain('Host: example.com\r\n');
  });
});
