/*
 * The `requirements:` declaration, shared by the service and the sandbox.
 *
 * Packages are declared inside the submitted code rather than in a request
 * field because the callers that need this write code through a fixed tool
 * schema they cannot add fields to. Both comment markers are accepted (`#` for
 * Python/bash, `//` for JS/TS), which covers every shape those callers emit:
 *
 *     # requirements: cowsay, humanize>=4
 *     // requirements: lodash, left-pad@1.3.0
 *     # requirements(npm): lodash          <- explicit manager
 *
 * Without a qualifier the manager is inferred from the job's language, so the
 * common case is the short form. The qualifier exists for the mixed case: a
 * bash job that shells out to both `python3` and `node`.
 *
 * This module only EXTRACTS declarations. Validation of each spec — the
 * grammar that stops a requirement from turning into a pip/npm option, a URL,
 * or a local path — lives in the sandbox, on the trusted side of the request,
 * and is applied to whatever arrives regardless of which component parsed it.
 *
 * Both components need it because the raw user code only exists in the
 * service: with persistent sessions enabled the code is base64-encoded into a
 * wrapper before it reaches the sandbox, so a header would be invisible there.
 * The sandbox still parses too, so direct /api/v2 callers get the convention.
 */

export type PackageManager = 'pip' | 'npm';

export interface ExtractedRequirements {
  pip: string[];
  npm: string[];
  /** Qualifiers naming a manager this service does not implement. Reported as
   * an error rather than ignored: a declaration that silently does nothing is
   * worse than one that fails loudly, because the failure surfaces much later
   * as a confusing missing-module error. */
  unsupported: string[];
}

const REQUIREMENTS_LINE_RE =
  /^[ \t]*(?:#|\/\/)[ \t]*requirements[ \t]*(?:\(([A-Za-z0-9_-]+)\))?[ \t]*:[ \t]*(.+)$/gim;

/* Bounded so a large uploaded file cannot turn header parsing into a scan of
 * megabytes of text per job. Declarations belong at the top of a file. */
export const MAX_SOURCE_SCAN_BYTES = 64 * 1024;

const MANAGERS: readonly PackageManager[] = ['pip', 'npm'];

/** The manager a bare `requirements:` means for a given job language. */
export function defaultManagerFor(language: string): PackageManager {
  switch (language.toLowerCase()) {
    case 'js':
    case 'ts':
    case 'node':
    case 'bun':
    case 'bun-js':
    case 'bun-ts':
    case 'javascript':
    case 'typescript':
      return 'npm';
    default:
      // Python, bash and everything else. A bash job overwhelmingly shells out
      // to python3; `requirements(npm):` covers the rest.
      return 'pip';
  }
}

/**
 * Split one declaration into specs.
 *
 * Not a plain `split(',')`: a comma is also the separator *inside* a PEP 440
 * version specifier and inside an extras list, so `pandas>=2,<3` is one
 * requirement and `requests[socks,security]` is one requirement. Both are
 * accepted by the sandbox's validator and documented as usable, and splitting
 * naively turned them into the invalid packages `<3` and `security]`.
 *
 * A comma separates requirements only at bracket depth zero and only when what
 * follows starts a package name rather than another version operator.
 */
function splitDeclaredSpecs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      if (depth > 0) depth--;
    } else if (char === ',' && depth === 0) {
      let next = i + 1;
      while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
      if (next < text.length && '<>=!~^'.includes(text[next])) continue;
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map(spec => spec.trim()).filter(spec => spec.length > 0);
}

/**
 * Collect declared specs per manager, in order and de-duplicated. Empty lists
 * mean the job declared nothing, which every caller must treat as ordinary
 * rather than as an error.
 */
export function extractRequirements(
  sources: readonly string[],
  defaultManager: PackageManager = 'pip',
): ExtractedRequirements {
  const collected: Record<PackageManager, string[]> = { pip: [], npm: [] };
  const unsupported: string[] = [];

  for (const source of sources) {
    if (typeof source !== 'string' || source.length === 0) continue;
    const scanned = source.length > MAX_SOURCE_SCAN_BYTES
      ? source.slice(0, MAX_SOURCE_SCAN_BYTES)
      : source;
    REQUIREMENTS_LINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REQUIREMENTS_LINE_RE.exec(scanned)) !== null) {
      const qualifier = match[1]?.toLowerCase();
      let manager: PackageManager;
      if (qualifier === undefined) {
        manager = defaultManager;
      } else if ((MANAGERS as readonly string[]).includes(qualifier)) {
        manager = qualifier as PackageManager;
      } else {
        if (!unsupported.includes(qualifier)) unsupported.push(qualifier);
        continue;
      }
      for (const spec of splitDeclaredSpecs(match[2])) {
        collected[manager].push(spec);
      }
    }
  }

  return {
    pip: Array.from(new Set(collected.pip)),
    npm: Array.from(new Set(collected.npm)),
    unsupported,
  };
}
