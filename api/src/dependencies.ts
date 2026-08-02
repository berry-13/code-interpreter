/*
 * Validation for per-job runtime dependencies declared INSIDE the submitted
 * code. Two managers are implemented: pip and npm.
 *
 * The strict grammar is the security boundary for the installer command. For
 * both managers the same properties hold: a spec can never begin with `-` (so
 * it cannot become an option like `--index-url` or `--registry`), can never be
 * a URL or a filesystem path (so it cannot point away from the configured
 * index), and carries no whitespace or shell metacharacters. Installs are
 * spawned with an argv array and never through a shell.
 *
 * Pure and dependency-free so it can be unit-tested without the sandbox.
 */

import { extractRequirements, type PackageManager } from '../../shared/requirements-header';

export interface ValidatedDependencies {
  pip?: string[];
  npm?: string[];
}

export interface DependencyLimits {
  maxCount: number;
  /** When false, ranges and bare names are accepted and pip resolves the
   * version. See CODEAPI_DEPENDENCY_REQUIRE_PINNED. */
  requirePinned?: boolean;
}

// PEP 503-ish distribution name: alnum runs joined by . _ -; no leading/trailing
// separator. Case-insensitive.
const PIP_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Conservative PEP 440 version: digits, letters, and . ! + _ - only. No spaces
// or shell metacharacters.
const PIP_VERSION_RE = /^[A-Za-z0-9.!+_-]+$/;
/* A PEP 508 requirement without the parts that carry risk: no environment
 * markers (';' starts a second clause), no direct URL or path reference
 * ('@', '/'), no whitespace, no quoting or shell metacharacters. Only a name,
 * optional extras, and ordinary version specifiers. Used when pinning is not
 * required; the pinned path keeps its own stricter check below. */
const PIP_REQUIREMENT_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9,._-]+\])?(?:(?:===|==|!=|<=|>=|~=|<|>)[A-Za-z0-9.*!+_-]+(?:,(?:===|==|!=|<=|>=|~=|<|>)[A-Za-z0-9.*!+_-]+)*)?$/;
const PIP_HASH_RE = /^--hash=sha256:[0-9a-f]{64}$/;

/* npm package name, optionally scoped: `lodash`, `@types/node`. npm's own
 * rules are looser, but everything outside this set (URLs, `file:`, git refs,
 * paths, aliases) is a way to install from somewhere other than the registry. */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/* A semver range as npm accepts it after `@`: digits, dots, and the usual
 * range/prerelease punctuation. No spaces, no `:` (which would allow
 * `name@git+ssh://...`), no `/`. */
/* A range may legitimately START with an operator (`^1.3`, `>=18`), so those
 * characters are allowed in the leading position too — but never `/` or `:`,
 * which is what keeps `name@git+ssh://…` and `name@npm:other` out. */
const NPM_VERSION_RE = /^[A-Za-z0-9*^~><=][A-Za-z0-9.^~><=*+|-]*$/;
const NPM_EXACT_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const MAX_SPEC_LENGTH = 4096;

function fail(message: string): never {
  // Match the plain `{ message }` throw style used across api/src/api/v2.ts.
  throw { message };
}

/**
 * Validate and normalize a pip dependency list. Returns the same specs on
 * success (trimmed); throws `{ message }` on the first violation.
 */
export function validatePipDependencies(specs: unknown, limits: DependencyLimits): string[] {
  if (!Array.isArray(specs)) {
    fail('dependencies.pip must be an array of strings');
  }
  if (specs.length === 0) {
    fail('dependencies.pip must not be empty when provided');
  }
  if (specs.length > limits.maxCount) {
    fail(`dependencies.pip exceeds the maximum of ${limits.maxCount} packages`);
  }

  const normalized: string[] = [];
  let anyHashed = false;
  let allHashed = true;

  for (const [i, raw] of specs.entries()) {
    if (typeof raw !== 'string') {
      fail(`dependencies.pip[${i}] must be a string`);
    }
    const spec = raw.trim();
    if (spec.length === 0) {
      fail(`dependencies.pip[${i}] must not be empty`);
    }
    if (spec.length > MAX_SPEC_LENGTH) {
      fail(`dependencies.pip[${i}] is too long`);
    }
    // Whitespace only ever separates the requirement from --hash options.
    const tokens = spec.split(/\s+/);
    const requirement = tokens[0];
    const hashTokens = tokens.slice(1);

    if (limits.requirePinned === false) {
      /* Unpinned mode: a name, optional extras, optional version range; pip
       * resolves the rest. The characters that could smuggle another pip
       * option or a shell fragment are still absent by construction, and the
       * token still cannot begin with '-'. */
      if (!PIP_REQUIREMENT_RE.test(requirement)) {
        fail(`dependencies.pip[${i}] is not a valid package requirement`);
      }
    } else {
      const eq = requirement.indexOf('==');
      if (eq <= 0) {
        fail(`dependencies.pip[${i}] must be a pinned 'name==version' spec`);
      }
      const name = requirement.slice(0, eq);
      const versionField = requirement.slice(eq + 2);
      if (!PIP_NAME_RE.test(name)) {
        fail(`dependencies.pip[${i}] has an invalid package name`);
      }
      // Reject a second '==' or any range operators hiding in the version field.
      if (!PIP_VERSION_RE.test(versionField) || versionField.includes('==')) {
        fail(`dependencies.pip[${i}] must pin an exact version`);
      }
    }

    for (const hashTok of hashTokens) {
      if (!PIP_HASH_RE.test(hashTok)) {
        fail(`dependencies.pip[${i}] has an invalid --hash (expected --hash=sha256:<hex>)`);
      }
    }
    if (hashTokens.length > 0) {
      anyHashed = true;
    } else {
      allHashed = false;
    }

    normalized.push(spec);
  }

  // pip --require-hashes is all-or-nothing across the resolved graph; refuse a
  // partially hashed set so we never silently install unhashed packages.
  if (anyHashed && !allHashed) {
    fail('dependencies.pip must hash every package or none (pip --require-hashes is all-or-nothing)');
  }

  return normalized;
}

/**
 * Validate an npm dependency list. Same contract as the pip validator: returns
 * the trimmed specs, throws `{ message }` on the first violation.
 *
 * npm accepts a great deal more than a registry name in this position —
 * `file:../x`, `git+ssh://…`, `http://…/t.tgz`, `alias@npm:other` — and every
 * one of those is a way to install from somewhere the operator did not
 * configure. Only `name` and `name@range` are allowed through.
 */
export function validateNpmDependencies(specs: unknown, limits: DependencyLimits): string[] {
  if (!Array.isArray(specs)) {
    fail('dependencies.npm must be an array of strings');
  }
  if (specs.length === 0) {
    fail('dependencies.npm must not be empty when provided');
  }
  if (specs.length > limits.maxCount) {
    fail(`dependencies.npm exceeds the maximum of ${limits.maxCount} packages`);
  }

  const normalized: string[] = [];
  for (const [i, raw] of specs.entries()) {
    if (typeof raw !== 'string') {
      fail(`dependencies.npm[${i}] must be a string`);
    }
    const spec = raw.trim();
    if (spec.length === 0) {
      fail(`dependencies.npm[${i}] must not be empty`);
    }
    if (spec.length > MAX_SPEC_LENGTH) {
      fail(`dependencies.npm[${i}] is too long`);
    }
    // No whitespace at all: the spec becomes one argv element, and a space
    // would let a second argument ride along inside it.
    if (/\s/.test(spec)) {
      fail(`dependencies.npm[${i}] must not contain whitespace`);
    }

    /* Split on the LAST '@' so a scoped name keeps its leading one:
     * '@types/node@20' -> '@types/node' + '20'. */
    const at = spec.lastIndexOf('@');
    const hasVersion = at > 0;
    const name = hasVersion ? spec.slice(0, at) : spec;
    const version = hasVersion ? spec.slice(at + 1) : '';

    if (!NPM_NAME_RE.test(name)) {
      fail(`dependencies.npm[${i}] has an invalid package name`);
    }
    if (hasVersion && !NPM_VERSION_RE.test(version)) {
      fail(`dependencies.npm[${i}] has an invalid version range`);
    }
    if (limits.requirePinned !== false) {
      if (!hasVersion || !NPM_EXACT_VERSION_RE.test(version)) {
        fail(`dependencies.npm[${i}] must pin an exact version ('name@1.2.3')`);
      }
    }

    normalized.push(spec);
  }

  return normalized;
}

/*
 * The declaration lives in a comment in the code the caller submits:
 *
 *     # requirements: cowsay==6.1, requests==2.32.3
 *
 * It is a comment line rather than a request field because the only caller
 * that matters in practice is an LLM writing code through a fixed tool schema
 * it cannot extend. A request field is unreachable for such a caller; a line
 * of code is not. `#` is a comment in Python and in bash, which covers both
 * shapes LibreChat emits.
 *
 * Each manager keeps its own grammar; both refuse anything that could become
 * an installer option, a URL, or a local path.
 */
/**
 * Extract and validate requirements declared in submitted source. Returns
 * undefined when nothing is declared, so a job without the header behaves
 * exactly as it did before this existed.
 *
 * Throws `{ message }` when a declaration is present but the feature is off or
 * a spec is malformed: silently ignoring a declaration the caller wrote would
 * surface as a confusing missing-module error much further along.
 */
export function resolveDependencies(
  sources: string[],
  opts: {
    allow: boolean;
    maxCount: number;
    declared?: { pip?: string[]; npm?: string[] };
    requirePinned?: boolean;
    defaultManager?: PackageManager;
  },
): ValidatedDependencies | undefined {
  /* Two sources, same validation. `declared` is what the service already
   * extracted from the raw user code -- it must, because with persistent
   * sessions that code reaches us base64-encoded inside a wrapper and the
   * header would be invisible. Parsing `sources` as well keeps the convention
   * working for callers that post to /api/v2 directly. */
  const parsed = extractRequirements(sources, opts.defaultManager ?? 'pip');
  const declaredOf = (manager: PackageManager): string[] => {
    const list = opts.declared?.[manager];
    return Array.isArray(list) ? list.filter(s => typeof s === 'string') : [];
  };
  const pip = Array.from(new Set([...declaredOf('pip'), ...parsed.pip]));
  const npm = Array.from(new Set([...declaredOf('npm'), ...parsed.npm]));

  if (parsed.unsupported.length > 0) {
    fail(
      `requirements(${parsed.unsupported[0]}) is not supported; ` +
        'the available package managers are pip and npm',
    );
  }
  if (pip.length === 0 && npm.length === 0) return undefined;

  if (!opts.allow) {
    fail('dynamic dependencies are disabled (set CODEAPI_ALLOW_DYNAMIC_DEPENDENCIES=true to enable)');
  }

  const limits = { maxCount: opts.maxCount, requirePinned: opts.requirePinned };
  const resolved: ValidatedDependencies = {};
  if (pip.length > 0) resolved.pip = validatePipDependencies(pip, limits);
  if (npm.length > 0) resolved.npm = validateNpmDependencies(npm, limits);
  return resolved;
}
