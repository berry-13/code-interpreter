import { describe, expect, test } from 'bun:test';
import { createPayload } from './payload';
import { env } from './config';

function build(code: string, lang = 'py'): ReturnType<typeof createPayload> {
  return createPayload({
    req: { body: { code, lang } } as Parameters<typeof createPayload>[0]['req'],
    isPyPlot: false,
    session_id: undefined,
  } as Parameters<typeof createPayload>[0]);
}

describe('createPayload requirements extraction', () => {
  test('forwards a declared package', () => {
    const payload = build('# requirements: cowsay==6.1\nimport cowsay');
    expect(payload.dependencies).toEqual({ pip: ['cowsay==6.1'] });
  });

  test('omits the field when nothing is declared', () => {
    expect(build('print(1)').dependencies).toBeUndefined();
  });

  test('collects several packages and de-duplicates', () => {
    const payload = build('# requirements: a==1, b==2\n# requirements: a==1\nprint(1)');
    expect(payload.dependencies).toEqual({ pip: ['a==1', 'b==2'] });
  });

  test('works for bash, where # is also a comment', () => {
    const payload = build('# requirements: cowsay==6.1\npython3 -c "import cowsay"', 'bash');
    expect(payload.dependencies).toEqual({ pip: ['cowsay==6.1'] });
  });

  test('a bare header means npm for JS/TS languages', () => {
    for (const lang of ['js', 'ts', 'node']) {
      expect(build('// requirements: lodash@4.17.21\nrequire("lodash")', lang).dependencies)
        .toEqual({ npm: ['lodash@4.17.21'] });
    }
  });

  test('an explicit qualifier crosses the language default', () => {
    expect(build('# requirements(npm): lodash@4.17.21', 'py').dependencies)
      .toEqual({ npm: ['lodash@4.17.21'] });
    expect(build('// requirements(pip): cowsay==6.1', 'js').dependencies)
      .toEqual({ pip: ['cowsay==6.1'] });
  });

  test('a bash job can declare both managers at once', () => {
    const payload = build(
      '# requirements: cowsay==6.1\n# requirements(npm): lodash@4.17.21\n',
      'bash',
    );
    expect(payload.dependencies).toEqual({ pip: ['cowsay==6.1'], npm: ['lodash@4.17.21'] });
  });

  /* The regression that shipped once: with persistent sessions the user code
   * is base64-encoded into a wrapper, so the header is NOT present as text in
   * what the sandbox receives. Extraction must happen here, on the original
   * source, or the declaration silently does nothing. */
  test('extracts before the persistence wrapper hides the source', () => {
    const original = env.PERSIST_SESSIONS;
    (env as { PERSIST_SESSIONS: boolean }).PERSIST_SESSIONS = true;
    try {
      const payload = build('# requirements: cowsay==6.1\nimport cowsay');
      const shipped = payload.files[0].content;
      // The wrapper really did hide it...
      expect(shipped).not.toContain('# requirements: cowsay==6.1');
      // ...and the declaration still made it out.
      expect(payload.dependencies).toEqual({ pip: ['cowsay==6.1'] });
    } finally {
      (env as { PERSIST_SESSIONS: boolean }).PERSIST_SESSIONS = original;
    }
  });

  /* Same reasoning for the error case: an unsupported manager is only ever
   * visible in the original source, so if it does not ride along in the
   * payload the sandbox has nothing to report and the job just runs. */
  test('forwards an unsupported manager so the sandbox can reject the job', () => {
    expect(build('# requirements(cargo): serde\nprint(1)').dependencies)
      .toEqual({ unsupported: ['cargo'] });
  });

  test('forwards an unsupported manager alongside supported ones', () => {
    expect(build('# requirements: cowsay==6.1\n# requirements(gem): rails\n').dependencies)
      .toEqual({ pip: ['cowsay==6.1'], unsupported: ['gem'] });
  });

  /* Scanning raw text found declarations that are not declarations: a
   * docstring or template literal that merely CONTAINS the line was treated as
   * one, so a program printing its own usage had those packages installed for
   * it — or, with the feature off, was rejected outright. */
  test('ignores a declaration inside a docstring', () => {
    expect(build('"""\nUsage:\n# requirements: cowsay==6.1\n"""\nprint(1)').dependencies)
      .toBeUndefined();
  });

  test('ignores a declaration inside a template literal', () => {
    expect(build('const usage = `\n// requirements: lodash@4.17.21\n`;\nconsole.log(usage);', 'js').dependencies)
      .toBeUndefined();
  });

  test('still reads a real declaration after a docstring closes', () => {
    expect(build('"""doc"""\n# requirements: cowsay==6.1\nimport cowsay').dependencies)
      .toEqual({ pip: ['cowsay==6.1'] });
  });

  test('ignores a declaration on the continued line of a string', () => {
    /* A backslash before the newline keeps the string open, so the next
     * physical line is still inside it — and it would otherwise be read as a
     * declaration whose spec carries the closing quote. */
    expect(build('usage = "start \\\n# requirements: cowsay==6.1\\\nend"\nprint(usage)').dependencies)
      .toBeUndefined();
  });

  test('a quote inside a comment does not swallow the rest of the file', () => {
    expect(build("# it's a comment\n# requirements: cowsay==6.1\nimport cowsay").dependencies)
      .toEqual({ pip: ['cowsay==6.1'] });
  });

  test('keeps a comma that belongs to a version specifier or an extras list', () => {
    expect(build('# requirements: pandas>=2,<3\n').dependencies)
      .toEqual({ pip: ['pandas>=2,<3'] });
    expect(build('# requirements: requests[socks,security], cowsay\n').dependencies)
      .toEqual({ pip: ['requests[socks,security]', 'cowsay'] });
  });
});
