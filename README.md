# Code Interpreter

Sandboxed code execution service for LibreChat, providing secure execution of user-submitted code with file storage and tool calling capabilities.

## Overview

Code Interpreter (internally `codeapi`, the prefix used by its env vars, images, and helm chart) is a multi-component service that enables LibreChat to safely execute user code in isolated sandboxes. It consists of five independently scalable components that communicate via Redis queues and S3-compatible storage.

## Components

- **API** - HTTP gateway that accepts code execution requests and returns results
- **Worker Sandbox** - Executes code in NsJail (or libkrun microVM) sandboxes with resource limits
- **File Server** - Manages file uploads/downloads via S3 (IRSA authentication)
- **Tool Call Server** - Handles programmatic tool calls from within sandbox sessions
- **Package Init** - One-time job that pre-installs language runtimes (Python, Node, Bun) onto a shared PVC

## Architecture

1. LibreChat sends a code execution request to the **API**
2. API enqueues the job in Redis
3. **Worker Sandbox** picks up the job and executes code inside an isolated sandbox
4. Files are persisted/retrieved via the **File Server** (backed by S3)
5. Tool calls from within sandboxes are routed through the **Tool Call Server**

## Sandbox Isolation

Two modes are supported:

- **NsJail mode** (`kvmEnabled: false`): Direct NsJail sandboxing with Linux namespaces and cgroups
- **MicroVM mode** (`kvmEnabled: true`): libkrun microVM with its own kernel, NsJail runs inside the guest

## Security disclaimer

This service exists to run arbitrary, untrusted code — treat every
deployment decision accordingly.

In its full hardened configuration — MicroVM mode (`kvmEnabled: true`, so
sandboxed code runs under a separate guest kernel) with NsJail inside the
guest, seccomp filtering, the egress gateway in front of all
sandbox-originated traffic, network policies applied, signed execution
manifests, and `hardenedSandboxMode` left on — it is reasonably secure and
designed with defense in depth. NsJail-only mode shares the host kernel and
provides meaningfully weaker isolation: it is appropriate for local
development, not for executing untrusted code from people you don't trust.

No software is 100% secure. Sandbox escapes, kernel vulnerabilities, and
misconfiguration are all real risks for any code-execution system. Keep the
hardening defaults on, run the stack on isolated infrastructure with least
privilege, keep hosts patched, and deploy responsibly. If you believe you
have found a vulnerability, please report it privately rather than opening a
public issue (see [CONTRIBUTING](CONTRIBUTING.md)).

## Local Development

```bash
docker-compose up --build
```

On first start the one-shot `package_init` service downloads the language
runtimes into `./data/pkgs` (override with `SANDBOX_PACKAGES_PATH`), so no
runtimes need to be installed on the host. The volume is reused on later
starts; already-installed runtimes are skipped. To install only a subset of
languages, set `CODEAPI_LANGUAGES` (comma-separated list of `python`, `node`,
`bun`, `bash`, `java`; default all):

```bash
CODEAPI_LANGUAGES=python docker-compose up --build
```

Adding a language later (e.g. `CODEAPI_LANGUAGES=python,bun`) installs only
the missing runtime into the existing volume. Set `FORCE_REBUILD=true` to
wipe and rebuild the volume from scratch.

### Prebuilt images

To skip building from source, use the pull-based compose file. It mirrors the
default stack but pulls every image from GHCR (`ghcr.io/berry-13/codeapi-*`),
published by the `publish-images` workflow on each push to `main` and on
version tags:

```bash
docker compose -f docker-compose.prebuilt.yml up
```

The `package_init` service still populates `./data/pkgs` on first start, so the
same `CODEAPI_LANGUAGES` and `SANDBOX_PACKAGES_PATH` options apply. Prebuilt
images are `linux/amd64` only for now; on other architectures, build from source
with the default compose file instead.

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

### Running without KVM

The default stack boots the sandbox inside a libkrun microVM and maps
`/dev/kvm` into the sandbox container. On hosts without a usable `/dev/kvm`
(cheap VPSes, LXC containers, nested virtualization without KVM passthrough)
Docker fails to start that container. Layer the NsJail-only override to run
without KVM:

```bash
docker compose -f docker-compose.yaml -f docker-compose.nokvm.yml up
```

For the scalable stack, use its companion override:

```bash
docker compose -f docker-compose.scalable.yml -f docker-compose.scalable.nokvm.yml up
```

NsJail-only mode shares the host kernel and provides meaningfully weaker
isolation than the default microVM mode. It is appropriate for local
development and trusted use, not for executing untrusted code from people you
don't trust; see the [Security disclaimer](#security-disclaimer) above.

### Dynamic dependencies

Beyond the runtimes baked into the packages volume, an exec request can
declare extra Python packages to install just for that job. This is **off by
default**; enable it with `CODEAPI_ALLOW_DYNAMIC_DEPENDENCIES=true`.

```bash
curl -X POST http://localhost:3112/v1/exec -H 'Content-Type: application/json' -d '{
  "lang": "python",
  "code": "import cowsay; cowsay.cow(\"hello\")",
  "dependencies": { "pip": ["cowsay==6.1"] }
}'
```

Each entry must be a pinned `name==version` spec and may carry one or more
` --hash=sha256:...` options (when any package is hashed, all must be, and pip
runs with `--require-hashes`). Installs happen **before** user code runs, in
the trusted runner, using `pip --only-binary=:all:` — only prebuilt wheels are
used, so **no package build or setup.py code executes at install time**. The
result is mounted read-only into the sandbox on `PYTHONPATH`; the sandbox
itself still has no network.

How the security boundary is preserved, and its limits:

- The sandbox gains no new capability — only the trusted runner fetches from
  the index (`CODEAPI_DEPENDENCY_INDEX_URL`, default PyPI), so enabling this
  requires the runner to have outbound HTTPS to that index.
- Packages without a prebuilt wheel for the runtime (CPython + arch) are
  rejected rather than built from source. Native/source-only packages are not
  supported in this mode.
- Limits: `CODEAPI_DEPENDENCY_MAX_COUNT`,
  `CODEAPI_DEPENDENCY_INSTALL_TIMEOUT_MS`, `CODEAPI_DEPENDENCY_MAX_BYTES`.
- Only trusted infrastructure runs `pip` (as the per-job UID, with a minimal
  env); the untrusted user code runs afterward under the unchanged hardened
  sandbox. Still, enable it only when you accept installing operator-allowed
  packages from the configured index.

## LibreChat integration

LibreChat talks to this service over HTTP. Point it at the **API** component,
which listens on port `3112` and serves every route under the `/v1` prefix
(for example `GET /v1/health`, `POST /v1/exec`). Set `LIBRECHAT_CODE_BASEURL`
on the LibreChat side to that base URL, including the `/v1` suffix:

```bash
# LibreChat .env
LIBRECHAT_CODE_BASEURL=http://codeapi-host:3112/v1
```

Use the internal service name (for example `http://api:3112/v1`) when
LibreChat and this service share a Docker network.

Authentication has two supported modes: unauthenticated (local/dev only) and
LibreChat JWT (EdDSA), controlled by `CODEAPI_AUTH_PROVIDER` on this service.
The legacy `X-API-Key` header is no longer accepted; outside local mode the
API requires a `Bearer` JWT.

### Unauthenticated mode (local/dev only)

The default Docker Compose files run with `LOCAL_MODE=true`, which bypasses
authentication entirely and stamps every request with a fixed local
principal. In this mode LibreChat needs only `LIBRECHAT_CODE_BASEURL`; leave
its `CODEAPI_JWT_*` variables unset. Nothing else is required on either side.

If you run with `LOCAL_MODE=false` but still want no authentication, set both
of these on the service instead:

```bash
# codeapi service .env
LOCAL_MODE=false
CODEAPI_AUTH_PROVIDER=none
CODEAPI_ALLOW_AUTH_PROVIDER_NONE=true
```

With `CODEAPI_AUTH_PROVIDER=none` the service takes the user id from the
`User-Id` request header (falling back to the request body `user_id`, then
`anonymous`). It refuses to start in this mode unless
`CODEAPI_ALLOW_AUTH_PROVIDER_NONE=true` is also set.

Warning: unauthenticated mode lets any caller execute arbitrary code. Never
expose it on a public network or shared host. Use it only on a loopback or a
trusted private network, and switch to JWT mode for anything else.

### JWT (EdDSA) mode

In JWT mode LibreChat signs a short-lived EdDSA (Ed25519) JWT with a private
key and sends it as `Authorization: Bearer <token>`. This service verifies
the signature with the matching public key. The private key stays on the
LibreChat side and never reaches this service.

Generate an Ed25519 keypair:

```bash
# Private key stays with LibreChat (the signer)
openssl genpkey -algorithm ed25519 -out jwt-codeapi.key

# Public key goes to this service (the verifier)
openssl pkey -in jwt-codeapi.key -pubout -out jwt-codeapi.pub
```

Configure LibreChat to mint tokens with the private key. LibreChat populates
the required claims (`iss`, `aud`, `sub`, `jti`, `iat`, `nbf`, `exp`,
`principal_source`, `auth_context_hash`) automatically:

```bash
# LibreChat .env
LIBRECHAT_CODE_BASEURL=http://codeapi-host:3112/v1
CODEAPI_AUTH_PROVIDER=librechat-jwt
CODEAPI_JWT_ALGORITHM=EdDSA
CODEAPI_JWT_KID=lc-codeapi-1
CODEAPI_JWT_ISSUER=librechat
CODEAPI_JWT_AUDIENCE=codeapi
# Paste the contents of jwt-codeapi.key (newlines may be escaped as \n)
CODEAPI_JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Configure this service to verify with the public key. `CODEAPI_JWT_KID` must
match the `kid` LibreChat signs with, and `CODEAPI_JWT_ISSUER` /
`CODEAPI_JWT_AUDIENCE` must match the values LibreChat mints:

```bash
# codeapi service .env
LOCAL_MODE=false
CODEAPI_AUTH_PROVIDER=librechat-jwt
CODEAPI_JWT_ISSUER=librechat
CODEAPI_JWT_AUDIENCE=codeapi
CODEAPI_JWT_ALLOWED_ALGS=EdDSA
CODEAPI_JWT_KID=lc-codeapi-1
# Paste the contents of jwt-codeapi.pub (newlines may be escaped as \n)
CODEAPI_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

Settings that must match on both sides: the algorithm (`EdDSA`), the key id
(`CODEAPI_JWT_KID` here equals the signer's `kid`; a token with an unknown
`kid` is rejected), the issuer (`CODEAPI_JWT_ISSUER`, default `librechat`),
and the audience (`CODEAPI_JWT_AUDIENCE`, default `codeapi`). Tokens are
capped at a 300-second lifetime (`CODEAPI_JWT_MAX_TTL_SECONDS`) with 30
seconds of clock skew tolerance. Because `LOCAL_MODE=true` bypasses auth
entirely, JWT mode requires `LOCAL_MODE=false`.

For key rotation or multiple verifier keys, this service also accepts
`CODEAPI_JWT_JWKS_JSON` (an inline JWKS document) or
`CODEAPI_JWT_PUBLIC_KEYS_DIR` (a directory of PEM files named by `kid`) in
place of `CODEAPI_JWT_PUBLIC_KEY` + `CODEAPI_JWT_KID`.

### Language runtimes

`CODEAPI_LANGUAGES` selects which runtimes are pre-installed; see the Local
Development section above.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
