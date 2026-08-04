import fs from 'fs';
import path from 'path';
import type * as t from './types';
import { planLimits, languageConfig, resolveLanguage, env } from './config';
import { Languages } from './enum';
import { wrapPythonForSessionPersistence } from './session-persist';
import { defaultManagerFor, extractRequirements } from '../../shared/requirements-header';

export const templateCode = fs.readFileSync(path.join(__dirname, 'matplotlib.py'), 'utf8');

export function createPayload({
  req,
  isPyPlot,
  session_id,
}: t.CreatePayload): t.PayloadBody {
  const { lang: rawLang, code: userCode, args, files, run_timeout } = req.body as t.RequestBody;
  const language = resolveLanguage(rawLang);
  if (language === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }
  const config = languageConfig[language];
  if (config === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }

  /* Extract the `# requirements:` declaration from the ORIGINAL user code,
   * before any wrapping. It has to happen here: with persistent sessions the
   * code is base64-encoded into the wrapper below, so the sandbox would never
   * see the header as text. The sandbox validates whatever we forward -- this
   * side only reads it. */
  const requirements = extractRequirements([userCode ?? ''], defaultManagerFor(language));

  let finalCode: string;
  if (isPyPlot === true) {
    // 4-space indent: the user block sits directly inside the template's
    // `if __name__ == "__main__":` (see matplotlib.py). Keep in sync with
    // that nesting.
    const indentedUserCode = userCode.trim().split('\n').map(line => `    ${line}`).join('\n');
    finalCode = templateCode.replace(
      /# BEGIN USER CODE\n[\s\S]*?# END USER CODE/,
      `# BEGIN USER CODE\n${indentedUserCode}\n    # END USER CODE`
    );
  } else {
    finalCode = userCode;
  }

  /* Persistent sessions (opt-in): wrap Python so the run restores its prior
   * global namespace and snapshots it back (via dill) around the user code.
   * Other languages get file-only persistence (the workspace tar), so they
   * need no code wrapping. See session-persist.ts for the wrapper's rationale. */
  if (env.PERSIST_SESSIONS && language === Languages.py) {
    finalCode = wrapPythonForSessionPersistence(finalCode, config.fileName);
  }

  const run_memory_limit = planLimits[req.planId ?? '']?.run_memory_limit ?? planLimits.default.run_memory_limit;
  const payload: t.PayloadBody = {
    run_memory_limit,
    language: config.language,
    version: config.version,
    files: [
      {
        name: config.fileName,
        content: finalCode
      }
    ]
  };

  /* Forward per manager, and forward `unsupported` with them. It has to travel:
   * the sandbox re-parses `finalCode` for direct callers, but for a persistent
   * Python session that code is a base64 wrapper, so a `requirements(cargo):`
   * header is invisible there. Dropping it here is what would silently run the
   * job instead of producing the promised error naming the manager. */
  if (
    requirements.pip.length > 0
    || requirements.npm.length > 0
    || requirements.unsupported.length > 0
  ) {
    payload.dependencies = {
      ...(requirements.pip.length > 0 ? { pip: requirements.pip } : {}),
      ...(requirements.npm.length > 0 ? { npm: requirements.npm } : {}),
      ...(requirements.unsupported.length > 0 ? { unsupported: requirements.unsupported } : {}),
    };
  }

  if (session_id) {
    payload.session_id = session_id;
  }

  if (args) {
    payload.args = args;
  }

  /* The router has already validated and clamped this against MAX_RUN_TIMEOUT
   * (resolveRequestedRunTimeout) and rejected malformed values, so anything
   * reaching here is a safe positive integer. Absent means "sandbox default". */
  if (run_timeout != null) {
    payload.run_timeout = run_timeout;
  }

  if (files && files.length > 0) {
    files.forEach(obj => {
      /* The sandbox downloads files by `(storage_session_id, id)`;
       * `kind`/`version` are sessionKey-derivation inputs at the
       * service entry only, not consumed downstream. */
      payload.files.push({
        id: obj.id,
        storage_session_id: obj.storage_session_id,
        name: obj.name,
      });
    });
  }

  return payload;
}