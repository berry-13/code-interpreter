import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * The site is served from the root of its custom domain
 * (codeapi.berry13.com — see `public/CNAME`), so no base path is needed.
 *
 * Set `DOCS_BASE_PATH=/code-interpreter` to build for the bare GitHub Pages
 * project URL instead, which serves from a subdirectory.
 */
const basePath = process.env.DOCS_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath,
  // The repo root also has a lockfile; pin the root so Next stops guessing.
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  // Pages has no Next.js image optimizer behind it.
  images: { unoptimized: true },
  // Emit `about/index.html` rather than `about.html` so Pages resolves
  // directory-style URLs without needing a redirect it cannot perform.
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default withMDX(config);
