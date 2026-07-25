# Code Interpreter

Sandboxed code execution service for LibreChat — runs untrusted,
model-generated code with real isolation, file storage, and tool calling.

**📖 [Documentation](https://codeapi.berry13.com)** ·
[Quickstart](https://codeapi.berry13.com/docs/guides/quickstart) ·
[API reference](https://codeapi.berry13.com/docs/reference) ·
[Architecture](https://codeapi.berry13.com/docs/developers/architecture)

## Quickstart

```bash
CODEAPI_LANGUAGES=python docker compose up --build
```

On first start a one-shot `package_init` service downloads the language
runtimes into `./data/pkgs`, so nothing needs installing on the host. The API
then listens on port `3112`, serving every route under `/v1`:

```bash
curl -sX POST http://localhost:3112/v1/exec \
  -H 'Content-Type: application/json' \
  -d '{"lang":"py","code":"print(sum(range(10)))"}'
```

To skip building from source, use `docker compose -f docker-compose.prebuilt.yml up`.
On hosts without `/dev/kvm`, see
[running without KVM](https://codeapi.berry13.com/docs/guides/deployment/without-kvm).

## Connecting LibreChat

Point LibreChat at the API component, including the `/v1` suffix:

```bash
# LibreChat .env
LIBRECHAT_CODE_BASEURL=http://codeapi-host:3112/v1
```

The local Docker Compose files run with `LOCAL_MODE=true`, which needs no
further setup. For anything else, configure JWT authentication — see
[Connecting LibreChat](https://codeapi.berry13.com/docs/guides/librechat).

## Components

Independently scalable services communicating over Redis and S3-compatible
storage, plus a one-shot runtime installer:

| Component            | Port | Role                                                           |
| -------------------- | ---- | -------------------------------------------------------------- |
| **API**              | 3112 | Public HTTP entry point — authenticates, validates, enqueues   |
| **Worker**           | 3113 | Consumes jobs, mints signed capabilities, drives the sandbox   |
| **Sandbox runner**   | 2000 | Executes code under NsJail, inside a microVM                   |
| **File server**      | 3000 | S3-backed session file storage                                 |
| **Tool call server** | 3033 | Routes tool calls from sandboxes back to callers               |
| **Egress gateway**   | 3190 | The only network path out of a sandbox                         |
| **package_init**     | —    | One-shot job installing language runtimes onto a shared volume |

See [Architecture](https://codeapi.berry13.com/docs/developers/architecture)
for how they fit together and why the split exists.

## Security

This service exists to run arbitrary, untrusted code — treat every deployment
decision accordingly.

In its full hardened configuration — MicroVM mode (`kvmEnabled: true`, so
sandboxed code runs under a separate guest kernel) with NsJail inside the
guest, seccomp filtering, the egress gateway in front of all sandbox-originated
traffic, network policies applied, signed execution manifests, and
`hardenedSandboxMode` left on — it is reasonably secure and designed with
defense in depth.

**NsJail-only mode shares the host kernel** and provides meaningfully weaker
isolation: it is appropriate for local development, not for executing untrusted
code from people you don't trust.

No software is 100% secure. Sandbox escapes, kernel vulnerabilities, and
misconfiguration are all real risks for any code-execution system. Keep the
hardening defaults on, run the stack on isolated infrastructure with least
privilege, keep hosts patched, and deploy responsibly.

Before exposing this to real users, work through
[production hardening](https://codeapi.berry13.com/docs/guides/deployment/hardening) —
the development defaults disable authentication and ship publicly known secrets.

If you believe you have found a vulnerability, please report it privately
rather than opening a public issue (see [CONTRIBUTING](CONTRIBUTING.md)).

## Documentation

-   [Guides](https://codeapi.berry13.com/docs/guides/quickstart) —
    install, configure, integrate, operate
-   [API reference](https://codeapi.berry13.com/docs/reference) —
    every endpoint, generated from the OpenAPI specs
-   [Developers](https://codeapi.berry13.com/docs/developers/architecture) —
    architecture, security model, contributing

The site lives in [`docs/`](docs) and is published to GitHub Pages on every push
to `main`. Component-level notes also live next to the code in
[`helm/codeapi/`](helm/codeapi), [`apparmor/`](apparmor), and [`seccomp/`](seccomp).

## Health checks

-   API: `GET /v1/health`
-   Worker: `GET /health`, `GET /ready`
-   Sandbox runner: `GET /api/v2/health`, `GET /api/v2/runtimes`
-   File server: `GET /health`, `GET /ready`
-   Tool call server: `GET /health`
-   Egress gateway: `GET /live`, `GET /health`, `GET /ready`

## Contributing

This repository is published from an internal monorepo; changes land here as
sync commits. Pull requests are welcome and are imported with attribution
preserved — see [CONTRIBUTING](CONTRIBUTING.md) and the
[contributing guide](https://codeapi.berry13.com/docs/developers/contributing).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
