import fs from 'fs';
import path from 'path';
import type * as t from './types';
import { planLimits, languageConfig, resolveLanguage, env } from './config';
import { Languages } from './enum';
import { wrapPythonForSessionPersistence } from './session-persist';

export const templateCode = fs.readFileSync(path.join(__dirname, 'matplotlib.py'), 'utf8');

export function createPayload({
  req,
  isPyPlot,
  session_id,
}: t.CreatePayload): t.PayloadBody {
  const { lang: rawLang, code: userCode, args, files } = req.body as t.RequestBody;
  const language = resolveLanguage(rawLang);
  if (language === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }
  const config = languageConfig[language];
  if (config === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }

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

  if (session_id) {
    payload.session_id = session_id;
  }

  if (args) {
    payload.args = args;
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