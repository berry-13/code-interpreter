/*
 * Validation for request-declared, per-job runtime dependencies.
 *
 * MVP: pip only. Every spec must be a pinned `name==version` requirement,
 * optionally followed by one or more ` --hash=sha256:<hex>` options. The strict
 * grammar is the security boundary for the installer command: only `--hash`
 * options are accepted, the requirement token can never begin with `-`, and no
 * whitespace/shell metacharacters survive, so nothing can smuggle an extra pip
 * option (e.g. `--index-url`, `--editable`, a URL, or a local path).
 *
 * Pure and dependency-free so it can be unit-tested without the sandbox.
 */

export interface ValidatedDependencies {
  pip: string[];
}

export interface DependencyLimits {
  maxCount: number;
}

// PEP 503-ish distribution name: alnum runs joined by . _ -; no leading/trailing
// separator. Case-insensitive.
const PIP_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Conservative PEP 440 version: digits, letters, and . ! + _ - only. No spaces
// or shell metacharacters.
const PIP_VERSION_RE = /^[A-Za-z0-9.!+_-]+$/;
const PIP_HASH_RE = /^--hash=sha256:[0-9a-f]{64}$/;
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
 * Top-level gate used by getJob. Returns the validated dependency set, or
 * undefined when the request declared none. Throws `{ message }` when the
 * feature is disabled or the language does not support the requested manager.
 */
export function resolveDependencies(
  dependencies: { pip?: string[] } | undefined,
  runtimeLanguage: string,
  opts: { allow: boolean; maxCount: number },
): ValidatedDependencies | undefined {
  if (dependencies == null) return undefined;
  if (typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    fail('dependencies must be an object');
  }
  const hasPip = dependencies.pip !== undefined;
  if (!hasPip) return undefined;

  if (!opts.allow) {
    fail('dynamic dependencies are disabled (set CODEAPI_ALLOW_DYNAMIC_DEPENDENCIES=true to enable)');
  }
  if (runtimeLanguage !== 'python') {
    fail(`dependencies.pip is only supported for python runtimes, not '${runtimeLanguage}'`);
  }
  return { pip: validatePipDependencies(dependencies.pip, { maxCount: opts.maxCount }) };
}
