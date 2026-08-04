# Reviewer's guide: codeapi-containerized-runtimes

Untracked file, not part of the branch. Per commit: what to scrutinize and
what was verified how. All verification ran on bare-metal Linux (ZimaCube,
/dev/kvm present), Docker 29.6.1, Compose v5.3.0.

## fcefc72 feat(docker): containerized runtime install with CODEAPI_LANGUAGES selection

Scrutinize:
- package-init.sh language gating: the per-language `<lang>_ready()` checks
  decide skips; make sure the readiness conditions are strong enough (python
  checks four site-packages dirs plus marker; node/bun check the whole JS
  manifest against installed package.json versions).
- packages_ready() only checks SELECTED languages, so a marker written by a
  python-only run correctly does not block a later python,bun run.
- Compose: package_init mounts the packages path rw, sandbox-runner still ro.
  Env passthrough uses `${VAR:-}` so empty means script defaults; defaults are
  deliberately not duplicated in compose.

Verified:
- Script level in a buildpack-deps:bookworm container with a tmp /pkgs:
  bash-only install, idempotent re-run ("already initialized", exit 0),
  invalid language exits 1, empty selection exits 1, spaces tolerated,
  adding bun to an existing bash volume skips bash and installs the real Bun
  plus all 8 JS package batches.
- Full compose stack: CODEAPI_LANGUAGES=python first boot populated the
  volume, sandbox-runner healthcheck passed, /api/v2/runtimes listed
  python 3.14.4, and POST /v1/exec ran python with numpy, then matplotlib
  PNG render with file-server upload (files[] in the response).
- helm template renders CODEAPI_LANGUAGES with and without the value set
  (rendered via alpine/helm with chart deps stubbed; no cluster here).

## e80ad59 feat(docker): install prebuilt CPython instead of compiling from source

Scrutinize:
- The pinned PYTHON_BUILD_STANDALONE_TAG=20260414. Newer PBS releases have
  already dropped 3.14.4 (latest tag 20260623 only ships 3.14.6), which is
  why the tag is pinned rather than resolved from latest-release.json. If you
  bump PYTHON_VERSION you must bump the tag with it; the error message says
  so.
- install_only tarball layout is extracted with --strip-components=1 into the
  same PKG_DEST the compile used, so pkg-info.json/run/.env sit next to the
  JDK-style bin/lib dirs. The pip package list is byte-identical to before.

Verified:
- From a wiped ./data/pkgs: package_init completed in 191s wall (was ~11 min
  compiling on this i5; slower boxes save more).
- Canaries through the microVM: matplotlib rendered a PNG (uploaded to the
  file server), pandas/scipy/sklearn/PIL import, sys.version shows the PBS
  Clang build. The joblib "serial mode" warning also appears because the
  sandbox has no /dev/shm; it is not a PBS regression.
- Second run skips ("Packages already initialized"); a later default-language
  run added node/bun/bash/java incrementally without touching python
  (dir mtimes unchanged).
- glibc: guest rootfs is bookworm (glibc 2.36) >= PBS floor (2.17). Fine.

## be5ad56 feat(docker): working NsJail-only fallback for hosts without KVM

This is the commit that needs the most attention.

Scrutinize:
- seccomp/nsjail.json gains fsopen/fsconfig/fsmount/fspick/open_tree/
  move_mount/mount_setattr. Rationale: util-linux 2.41 on the Fedora 43
  runner image issues the new mount API instead of mount(2), so every bind in
  start-direct-sandbox.sh EPERM'd under the old whitelist. These calls are
  the modern spellings of already-allowed operations and are still gated on
  CAP_SYS_ADMIN, but it IS an expansion of an allowlist on a security
  boundary; please eyeball it.
- The nokvm overrides grant the same cap set as docker-compose.mac.yml plus
  apparmor=unconfined (docker-default AppArmor denies the mount propagation
  change unshare needs). The override file header points at loading
  apparmor/sandbox-nsjail as the stricter alternative.
- start-direct-sandbox.sh now replaces a merged-usr /usr/sbin symlink
  (Fedora 42+) with a real directory before binding the rootfs sbin over it;
  without this the first bind lands on /usr/bin and removes mount(8) itself.
  This code path had simply never run on the current base image.
- KVM guards in sandbox-entrypoint.sh / supervisor.sh: fail fast with a
  worded error instead of a cryptic launcher crash. Defaults unchanged
  (KVM_ENABLED still defaults to true everywhere).

Verified:
- docker compose -f docker-compose.yaml -f docker-compose.nokvm.yml up on
  this machine: runner healthy, python and bun exec round trips through
  direct NsJail (wall times ~60-110ms).
- Rendered config for both override pairs shows no devices entry and
  KVM_ENABLED=false (devices cleared via `!reset`).
- The KVM-missing guard prints the full message and exits 1 when the runner
  image starts with KVM_ENABLED=true and no /dev/kvm.
- NOT verified: the scalable worker-sandbox nokvm override end to end (same
  mechanism and scripts, but I did not boot the scalable stack).

## 6ca160d ci: publish images to GHCR and add pull-based compose file

Scrutinize:
- Token scope: workflow-level contents: read, packages: write only on the
  publish job. Action SHAs — I re-resolved every pinned SHA against
  refs/tags with git ls-remote (checkout SHA reused from ci.yml verbatim);
  worth one more pair of eyes since SHAs are unreviewable by sight.
- Matrix target for api/Dockerfile is set explicitly to sandbox-runner
  (compose builds it with no target, which resolves to the same last stage).

Verified:
- YAML parses, docker compose -f docker-compose.prebuilt.yml config -q
  passes, prebuilt file diffed against docker-compose.yaml service-by-service
  (only the build->image swap and header differ). The workflow itself cannot
  run until it lands on GitHub; treat the first main push as its test.
- actionlint was not available on this host, so it was not run.

## 4b7563a docs: LibreChat integration guide and .env.example cleanup

Scrutinize:
- Every env var name was verified against service/src/auth/* and
  scripts/setup-local-auth-env.js rather than Discord folklore; the claimed
  caps (300s TTL max, 30s skew max) match librechat-jwt.ts constants.
- The unauthenticated-mode warning wording.
- .env.example: Stripe/Mailgun/Mongo/newsletter boilerplate removed after
  grepping each for zero references. MINIO_NO_PORT kept (file-server reads
  it).

## 126ec1b feat: Java runtime via Temurin JDK

Scrutinize:
- run script derives the main class from the first filename
  (Main.java -> Main) and runs with -XX:+UseSerialGC -cp . — single
  public-class submissions only, which matches what LibreChat sends
  (languageConfig fileName Main.java). Multi-file compiles work (compile gets
  all filenames) but the entrypoint class is always file one.
- Service side: java added to Languages enum, languageConfig (21.0.11),
  aliases java/jdk/openjdk. This is what actually fixes
  "Unsupported language: java". Java routes to the other-queue.
- Java is in the default CODEAPI_LANGUAGES set (adds a ~200MB tarball to
  first boot). Trim the default if that is unwanted.

Verified on the default (microVM) stack:
- Compile+run round trip via /v1/exec; javac diagnostics in stderr on a
  syntax error; runaway allocation SIGKILLed by the cgroup; with
  SANDBOX_RUN_TIMEOUT=5000 an infinite loop died at 5014ms with status TO;
  default max heap ~491MB (quarter of the limit via JVM cgroup awareness).
- All five languages re-executed green on the final build.
- Service unit tests: 254 pass / 17 fail in a bun container, and the same
  17 fail on a pristine HEAD checkout (preamble-bash/tool-input-signature,
  environment-dependent) — no new failures from this branch.

## Known gaps / follow-ups

- The public /v1/exec ignores run_timeout and holds the HTTP request until
  JOB_TIMEOUT when user code loops forever (pre-existing, affects python the
  same way; reproduced on both).
- arm64 images: TODO in the publish workflow.
- Scalable-stack nokvm override untested end to end.
- helm chart changes rendered but not applied to a cluster.
