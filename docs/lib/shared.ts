export const appName = 'Code Interpreter';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/**
 * Base path the site is served under, empty on the custom domain, which
 * serves from the root.
 *
 * Absolute URLs the app builds itself (the static search index, for one) need
 * this prefix when the site is served from a subdirectory instead. Kept in
 * sync with `next.config.mjs` through the `DOCS_BASE_PATH` build-time
 * variable.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Canonical origin, used to build the absolute page URL in page actions. */
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://codeapi.berry13.com';

/**
 * LibreChat instance the "Open in LibreChat" page action points at.
 *
 * Defaults to the public demo, since LibreChat is self-hosted and readers of
 * these docs will not all have an instance. Point it at your own deployment
 * with `NEXT_PUBLIC_LIBRECHAT_URL`, or set it empty to drop the menu entry.
 */
export const libreChatUrl =
  process.env.NEXT_PUBLIC_LIBRECHAT_URL ?? 'https://demo.librechat.ai';

export const gitConfig = {
  user: 'berry-13',
  repo: 'code-interpreter',
  branch: 'main',
};
