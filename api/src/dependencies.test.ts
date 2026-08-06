import { describe, expect, test } from 'bun:test';
import {
  dependencyEgressPolicy,
  resolveDependencies,
  validateNpmDependencies,
  validatePipDependencies,
} from './dependencies';

const LIMITS = { maxCount: 5 };

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
  throw new Error('expected a throw');
}

describe('validatePipDependencies', () => {
  test('accepts pinned specs', () => {
    expect(validatePipDependencies(['numpy==2.1.0', 'six==1.16.0'], LIMITS)).toEqual([
      'numpy==2.1.0',
      'six==1.16.0',
    ]);
  });

  test('accepts hashed specs and trims', () => {
    const h = '--hash=sha256:' + 'a'.repeat(64);
    expect(validatePipDependencies([`  cowsay==6.1 ${h}  `], LIMITS)).toEqual([`cowsay==6.1 ${h}`]);
  });

  test('rejects unpinned / range specs', () => {
    expect(messageOf(() => validatePipDependencies(['numpy>=2.0'], LIMITS))).toMatch(/pinned/);
    expect(messageOf(() => validatePipDependencies(['numpy~=2.0'], LIMITS))).toMatch(/pinned|exact/);
    expect(messageOf(() => validatePipDependencies(['numpy'], LIMITS))).toMatch(/pinned/);
  });

  test('rejects option/injection attempts', () => {
    expect(messageOf(() => validatePipDependencies(['--index-url=http://evil==1'], LIMITS))).toMatch(/name/);
    expect(messageOf(() => validatePipDependencies(['numpy==2.1.0 ; rm -rf /'], LIMITS))).toMatch(/hash/);
    expect(messageOf(() => validatePipDependencies(['numpy==2.1.0 --index-url=http://x'], LIMITS))).toMatch(/hash/);
    expect(messageOf(() => validatePipDependencies(['-rrequirements.txt==1'], LIMITS))).toMatch(/name/);
    expect(messageOf(() => validatePipDependencies(['pkg==${HOME}'], LIMITS))).toMatch(/exact/);
  });

  test('enforces max count', () => {
    const many = Array.from({ length: 6 }, (_, i) => `p${i}==1.0`);
    expect(messageOf(() => validatePipDependencies(many, LIMITS))).toMatch(/maximum/);
  });

  test('rejects a partially hashed set', () => {
    const h = '--hash=sha256:' + 'b'.repeat(64);
    expect(messageOf(() => validatePipDependencies([`a==1.0 ${h}`, 'b==2.0'], LIMITS))).toMatch(/every package or none/);
  });

  test('rejects malformed hash', () => {
    expect(messageOf(() => validatePipDependencies(['a==1.0 --hash=sha256:xyz'], LIMITS))).toMatch(/invalid --hash/);
  });

  test('rejects non-string / empty', () => {
    expect(messageOf(() => validatePipDependencies([123 as unknown as string], LIMITS))).toMatch(/must be a string/);
    expect(messageOf(() => validatePipDependencies([], LIMITS))).toMatch(/not be empty/);
    expect(messageOf(() => validatePipDependencies('numpy==1' as unknown as string[], LIMITS))).toMatch(/array/);
  });
});

describe('resolveDependencies', () => {
  const OPTS = { allow: true, maxCount: 5 };

  test('returns undefined when no header is present', () => {
    expect(resolveDependencies(['print("hi")'], OPTS)).toBeUndefined();
    expect(resolveDependencies([], OPTS)).toBeUndefined();
    expect(resolveDependencies([''], OPTS)).toBeUndefined();
  });

  test('parses a pinned header', () => {
    expect(resolveDependencies(['# requirements: cowsay==6.1\nimport cowsay'], OPTS))
      .toEqual({ pip: ['cowsay==6.1'] });
  });

  test('accepts several packages on one line', () => {
    expect(resolveDependencies(['# requirements: cowsay==6.1, requests==2.32.3'], OPTS))
      .toEqual({ pip: ['cowsay==6.1', 'requests==2.32.3'] });
  });

  test('is tolerant of spacing and case, as an LLM will write it', () => {
    for (const header of [
      '#requirements:cowsay==6.1',
      '#   Requirements :   cowsay==6.1   ',
      '\t# REQUIREMENTS: cowsay==6.1',
    ]) {
      expect(resolveDependencies([header], OPTS)).toEqual({ pip: ['cowsay==6.1'] });
    }
  });

  test('finds the header anywhere in the file, not only the first line', () => {
    expect(resolveDependencies(['import os\n\n# requirements: cowsay==6.1\n'], OPTS))
      .toEqual({ pip: ['cowsay==6.1'] });
  });

  test('collects across files and de-duplicates', () => {
    expect(resolveDependencies([
      '# requirements: cowsay==6.1',
      '# requirements: cowsay==6.1, six==1.16.0',
    ], OPTS)).toEqual({ pip: ['cowsay==6.1', 'six==1.16.0'] });
  });

  test('refuses when the feature is disabled', () => {
    expect(messageOf(() => resolveDependencies(['# requirements: numpy==2.1.0'], { allow: false, maxCount: 5 })))
      .toMatch(/disabled/);
  });

  test('applies the pinned-spec grammar to declared packages', () => {
    // Unpinned, and the shell-metacharacter smuggling the grammar exists for.
    expect(messageOf(() => resolveDependencies(['# requirements: cowsay'], OPTS)))
      .toMatch(/pinned/);
    expect(messageOf(() => resolveDependencies(['# requirements: --index-url=http://evil/'], OPTS)))
      .toMatch(/pin|invalid/);
    // A shell metacharacter never survives: it lands in the version field,
    // which only accepts PEP 440 characters.
    expect(messageOf(() => resolveDependencies(['# requirements: cowsay==6.1; rm -rf /'], OPTS)))
      .toMatch(/pin|invalid/);
  });

  test('enforces the per-job package cap', () => {
    const many = Array.from({ length: 6 }, (_, i) => `pkg${i}==1.0`).join(', ');
    expect(messageOf(() => resolveDependencies([`# requirements: ${many}`], OPTS)))
      .toMatch(/maximum/);
  });

  test('ignores a header buried past the scan window', () => {
    const padded = 'x'.repeat(70 * 1024) + '\n# requirements: cowsay==6.1';
    expect(resolveDependencies([padded], OPTS)).toBeUndefined();
  });

  test('does not treat prose mentioning requirements as a declaration', () => {
    expect(resolveDependencies(['# requirements are documented in README'], OPTS)).toBeUndefined();
  });
});

describe('unpinned mode (CODEAPI_DEPENDENCY_REQUIRE_PINNED=false)', () => {
  const LOOSE = { maxCount: 10, requirePinned: false };

  test('accepts the shapes an LLM actually writes', () => {
    for (const spec of [
      'cowsay',
      'cowsay==6.1',
      'requests>=2.32',
      'numpy~=2.1',
      'pandas>=2,<3',
      'requests[socks]',
      'requests[socks,use_chardet_on_py3]>=2.32.3',
      'ruamel.yaml',
      'zope.interface==7.0',
      'a',
    ]) {
      expect(validatePipDependencies([spec], LOOSE)).toEqual([spec]);
    }
  });

  /* The threat model here is pip OPTION injection, not shell injection: specs
   * are written to a requirements file and pip is spawned with an argv array,
   * never through a shell. A requirements file does interpret lines beginning
   * with '-' as options, which is what the leading-character rule stops. */
  test('still refuses pip options, URLs, paths, markers and metacharacters', () => {
    for (const spec of [
      '--index-url=http://evil/',
      '-r/etc/passwd',
      '-e.',
      'requests @ https://evil/x.whl',
      'requests;os.system("x")',
      'requests; python_version<"3.9"',
      './local/path',
      '/abs/path',
      'requests`whoami`',
      'requests$(whoami)',
      'requests|tee',
      "requests'",
      'req uests',
    ]) {
      expect(() => validatePipDependencies([spec], LOOSE)).toThrow();
    }
  });

  test('a nonsense version is left for pip to reject, not treated as injection', () => {
    // '>' is a legitimate version operator; with no shell in the path this is
    // just an unsatisfiable requirement, and pip fails the job cleanly.
    expect(validatePipDependencies(['requests>evil.txt'], LOOSE)).toEqual(['requests>evil.txt']);
  });

  test('pinned mode is unchanged and still rejects a bare name', () => {
    expect(() => validatePipDependencies(['cowsay'], { maxCount: 10 })).toThrow();
    expect(() => validatePipDependencies(['cowsay'], { maxCount: 10, requirePinned: true })).toThrow();
  });

  test('the per-job cap and hash rules still apply', () => {
    const many = Array.from({ length: 11 }, (_, i) => `pkg${i}`);
    expect(() => validatePipDependencies(many, LOOSE)).toThrow(/maximum/ as unknown as string);
    const h = '--hash=sha256:' + 'a'.repeat(64);
    expect(() => validatePipDependencies([`a==1 ${h}`, 'b==2'], LOOSE)).toThrow();
  });
});

describe('validateNpmDependencies', () => {
  const LOOSE = { maxCount: 10, requirePinned: false };
  const PINNED = { maxCount: 10 };

  test('accepts registry names, scopes and ranges', () => {
    for (const spec of [
      'lodash',
      'lodash@4.17.21',
      'left-pad@^1.3',
      '@types/node',
      '@types/node@20.11.0',
      'react@>=18',
      'foo@1.x',
      'bar@1.2.3-beta.1',
    ]) {
      expect(validateNpmDependencies([spec], LOOSE)).toEqual([spec]);
    }
  });

  test('refuses every way of installing from somewhere other than the registry', () => {
    for (const spec of [
      'git+https://evil/x.git',
      'https://evil/x.tgz',
      'http://evil/x.tgz',
      'file:../x',
      './local',
      '/abs/path',
      'evil@git+ssh://git@h/x.git',
      'alias@npm:other',
      '--registry=http://evil/',
      '-g',
      'pkg;rm -rf /',
      'pkg`whoami`',
      'pkg$(whoami)',
      'pkg with space',
      '@scope',
      '@/bad',
    ]) {
      expect(() => validateNpmDependencies([spec], LOOSE)).toThrow();
    }
  });

  test('pinned mode requires an exact semver', () => {
    expect(validateNpmDependencies(['lodash@4.17.21'], PINNED)).toEqual(['lodash@4.17.21']);
    for (const spec of ['lodash', 'lodash@^4', 'lodash@latest', 'lodash@4', 'lodash@4.17']) {
      expect(() => validateNpmDependencies([spec], PINNED)).toThrow();
    }
  });

  test('enforces the per-job package cap', () => {
    const many = Array.from({ length: 11 }, (_, i) => `pkg${i}`);
    expect(() => validateNpmDependencies(many, LOOSE)).toThrow();
  });
});

describe('resolveDependencies across managers', () => {
  const OPTS = { allow: true, maxCount: 10, requirePinned: false };

  test('a bare header means the language default', () => {
    expect(resolveDependencies(['# requirements: cowsay'], { ...OPTS, defaultManager: 'pip' }))
      .toEqual({ pip: ['cowsay'] });
    expect(resolveDependencies(['// requirements: lodash'], { ...OPTS, defaultManager: 'npm' }))
      .toEqual({ npm: ['lodash'] });
  });

  test('an explicit qualifier overrides the default, in either comment style', () => {
    expect(resolveDependencies(['# requirements(npm): lodash'], { ...OPTS, defaultManager: 'pip' }))
      .toEqual({ npm: ['lodash'] });
    expect(resolveDependencies(['// requirements(pip): cowsay'], { ...OPTS, defaultManager: 'npm' }))
      .toEqual({ pip: ['cowsay'] });
  });

  test('a bash job can declare both', () => {
    expect(resolveDependencies(
      ['# requirements: cowsay\n# requirements(npm): lodash'],
      { ...OPTS, defaultManager: 'pip' },
    )).toEqual({ pip: ['cowsay'], npm: ['lodash'] });
  });

  test('merges what the service extracted with what it finds in the source', () => {
    expect(resolveDependencies(['// requirements: lodash'], {
      ...OPTS,
      defaultManager: 'npm',
      declared: { pip: ['cowsay'] },
    })).toEqual({ pip: ['cowsay'], npm: ['lodash'] });
  });

  test('an unimplemented manager fails loudly rather than being ignored', () => {
    expect(messageOf(() => resolveDependencies(['# requirements(cargo): serde'], OPTS)))
      .toMatch(/cargo\).*not supported/);
  });

  test('each manager gets its own grammar', () => {
    // '@' is a version separator for npm and part of nothing for pip.
    expect(messageOf(() => resolveDependencies(['# requirements: lodash@4.17.21'], OPTS)))
      .toMatch(/not a valid package requirement/);
  });
});

describe('declarations that are not a plain comma-separated list', () => {
  const OPTS = { allow: true, maxCount: 10, requirePinned: false };

  test('keeps a comma inside a pip version specifier', () => {
    // `pandas>=2,<3` is one requirement; splitting it yielded the invalid
    // package `<3`, which unpinned mode then rejected.
    expect(resolveDependencies(['# requirements: pandas>=2,<3'], OPTS))
      .toEqual({ pip: ['pandas>=2,<3'] });
  });

  test('keeps a comma inside an extras list', () => {
    expect(resolveDependencies(['# requirements: requests[socks,security]'], OPTS))
      .toEqual({ pip: ['requests[socks,security]'] });
  });

  test('still splits between requirements', () => {
    expect(resolveDependencies(['# requirements: cowsay, humanize>=4'], OPTS))
      .toEqual({ pip: ['cowsay', 'humanize>=4'] });
    expect(resolveDependencies(['# requirements: pandas>=2,<3, cowsay'], OPTS))
      .toEqual({ pip: ['pandas>=2,<3', 'cowsay'] });
    expect(resolveDependencies(['# requirements: requests[socks,security], cowsay'], OPTS))
      .toEqual({ pip: ['requests[socks,security]', 'cowsay'] });
  });
});

describe('limits and errors that span both managers', () => {
  const OPTS = { allow: true, maxCount: 4, requirePinned: false };

  test('the package cap is one budget for the job, not one per manager', () => {
    const sources = [
      '# requirements(pip): a, b, c',
      '# requirements(npm): d, e, f',
    ];
    expect(messageOf(() => resolveDependencies(sources, OPTS))).toMatch(/maximum/);
  });

  test('a mixed job inside the cap is fine', () => {
    expect(resolveDependencies(['# requirements(pip): a, b', '# requirements(npm): c, d'], OPTS))
      .toEqual({ pip: ['a', 'b'], npm: ['c', 'd'] });
  });

  test('an unsupported manager the service extracted still fails the job', () => {
    /* With a persistent session the sandbox only sees a base64 wrapper, so
     * `sources` carries no header at all and the service's list is the only
     * evidence the declaration existed. */
    expect(messageOf(() => resolveDependencies(
      ['print("wrapped")'],
      { ...OPTS, declared: { unsupported: ['cargo'] } },
    ))).toMatch(/cargo/);
  });
});

describe('dependencyEgressPolicy', () => {
  const DEFAULTS = {
    indexUrl: 'https://pypi.org/simple',
    npmRegistry: 'https://registry.npmjs.org',
    extraHosts: ['files.pythonhosted.org'],
  };

  test('allows the index, the registry and the hosts that serve their files', () => {
    expect(dependencyEgressPolicy(DEFAULTS)).toEqual({
      hosts: ['pypi.org', 'registry.npmjs.org', 'files.pythonhosted.org'],
      ports: [80, 443],
    });
  });

  test('carries a custom port into the allowlist', () => {
    expect(dependencyEgressPolicy({ ...DEFAULTS, indexUrl: 'https://mirror.internal:8443/simple' }).ports)
      .toEqual([80, 443, 8443]);
  });

  test('does not widen the policy for an unparseable index', () => {
    /* A typo in the configuration must not become "reach anything": the
     * install fails against a proxy that never learned the host. */
    expect(dependencyEgressPolicy({ ...DEFAULTS, indexUrl: 'not a url', extraHosts: [] }).hosts)
      .toEqual(['registry.npmjs.org']);
  });

  test('normalizes case and drops blank extra hosts', () => {
    const policy = dependencyEgressPolicy({ ...DEFAULTS, extraHosts: [' Files.PythonHosted.org ', '', '  '] });
    expect(policy.hosts).toEqual(['pypi.org', 'registry.npmjs.org', 'files.pythonhosted.org']);
  });
});
