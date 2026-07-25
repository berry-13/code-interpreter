# Documentation site

The Code Interpreter documentation, built with [Fumadocs](https://fumadocs.dev)
on Next.js and deployed to GitHub Pages as a static export.

Published at <https://berry-13.github.io/code-interpreter>.

## Working on it

```bash
npm install
npm run dev      # http://localhost:3000/code-interpreter
npm run build    # static export → out/
```

The dev server and the build both run `npm run openapi` first, which
regenerates the API reference pages from the specs.

## Where the content lives

| Path | Contents |
| --- | --- |
| `content/docs/guides/` | User-facing guides — install, configure, integrate, operate |
| `content/docs/developers/` | Internals — architecture, security model, contributing |
| `content/docs/reference/` | API reference landing page |
| `content/docs/*/meta.json` | Sidebar ordering; `"root": true` starts a sidebar tab |

Pages are MDX with `title`, `description`, and `icon` frontmatter. Icons are
[lucide](https://lucide.dev) names, resolved in `lib/source.ts`.

## Generated pages — do not edit

These two directories are **gitignored and rebuilt on every build**:

- `content/docs/reference/api/` — from `../service/openapi.yml`
- `content/docs/developers/sandbox-api/` — from `../api/openapi.yaml`

To change the API reference, edit the OpenAPI spec in the repository root, not
the generated MDX. `scripts/generate-openapi.mjs` does the generation.

## Layout

| Path | Purpose |
| --- | --- |
| `app/(home)/` | Landing page |
| `app/docs/` | Documentation layout and page renderer |
| `app/api/search/route.ts` | Static Orama search index, emitted at build time |
| `components/mdx.tsx` | MDX component map (Tabs, Steps, Accordions, …) |
| `components/api-page.tsx` | Renderer for generated OpenAPI pages |
| `lib/source.ts` | Content source adapter and icon resolution |
| `lib/shared.ts` | App name, GitHub coordinates, base path |
| `lib/openapi.ts` | OpenAPI server used to preload specs |

## Base path

GitHub Pages serves this from `/code-interpreter`, set in `next.config.mjs` and
mirrored to the client via `NEXT_PUBLIC_BASE_PATH` (the static search client
needs it to find its index).

For a custom domain or a user/org Pages site, build with an empty base path:

```bash
DOCS_BASE_PATH= npm run build
```

## Deployment

`.github/workflows/docs.yml` builds and deploys on pushes to `main` that touch
`docs/`, either OpenAPI spec, or the workflow itself. Pull requests build
without deploying, so a broken docs build fails before it lands.
