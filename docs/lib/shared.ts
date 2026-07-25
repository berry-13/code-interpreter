export const appName = 'Code Interpreter';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/**
 * Base path the site is served under — empty on the custom domain, which
 * serves from the root.
 *
 * Absolute URLs the app builds itself (the static search index, for one) need
 * this prefix when the site is served from a subdirectory instead. Kept in
 * sync with `next.config.mjs` through the `DOCS_BASE_PATH` build-time
 * variable.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const gitConfig = {
  user: 'berry-13',
  repo: 'code-interpreter',
  branch: 'main',
};
