import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * GitHub Pages serves this repo's site from `/code-interpreter`. Override with
 * `DOCS_BASE_PATH=''` when deploying to a custom domain or a user/org site.
 */
const basePath = process.env.DOCS_BASE_PATH ?? '/code-interpreter';

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
