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
`bun`, `bash`; default all):

```bash
CODEAPI_LANGUAGES=python docker-compose up --build
```

Adding a language later (e.g. `CODEAPI_LANGUAGES=python,bun`) installs only
the missing runtime into the existing volume. Set `FORCE_REBUILD=true` to
wipe and rebuild the volume from scratch.

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
