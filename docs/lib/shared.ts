export const appName = 'Code Interpreter';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/**
 * Base path the site is served under.
 *
 * GitHub Pages serves project sites from `https://<user>.github.io/<repo>`, so
 * absolute URLs the app builds itself (the static search index, for one) need
 * this prefix. Kept in sync with `next.config.mjs` via the `DOCS_BASE_PATH`
 * build-time variable — set that to an empty string when deploying to a custom
 * domain or to the root of a user/org Pages site.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const gitConfig = {
  user: 'berry-13',
  repo: 'code-interpreter',
  branch: 'main',
};
