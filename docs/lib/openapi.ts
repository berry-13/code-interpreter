import { createOpenAPI } from 'fumadocs-openapi/server';

/**
 * The two specs this repo publishes.
 *
 * `service/openapi.yml` is the public API LibreChat talks to.
 * `api/openapi.yaml` is the internal runner API, documented for contributors:
 * it is never exposed publicly.
 *
 * Listed by the same paths the generated MDX references, so preloaded
 * documents resolve from cache instead of being re-read per page. Both are read
 * straight from the source tree, so the reference pages cannot drift from the
 * specs that ship with the code.
 */
export const openapi = createOpenAPI({
  input: ['../service/openapi.yml', '../api/openapi.yaml'],
});
