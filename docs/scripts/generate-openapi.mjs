/**
 * Generates the API reference MDX pages from the repo's OpenAPI specs.
 *
 * Runs automatically before `dev` and `build`. The output directories are
 * gitignored — the YAML specs in `service/` and `api/` are the single source of
 * truth, so regenerating is always safe and never produces a diff to review.
 */
import { rm } from 'node:fs/promises';
import { generateFiles } from 'fumadocs-openapi';
import { createOpenAPI } from 'fumadocs-openapi/server';

/** One spec per output section, generated independently. */
const targets = [
  {
    label: 'public service API',
    spec: '../service/openapi.yml',
    output: './content/docs/reference/api',
  },
  {
    label: 'internal sandbox runner API',
    spec: '../api/openapi.yaml',
    output: './content/docs/developers/sandbox-api',
  },
];

for (const { label, spec, output } of targets) {
  await rm(output, { recursive: true, force: true });

  await generateFiles({
    input: createOpenAPI({ input: [spec] }),
    output,
    includeDescription: true,
    groupBy: 'tag',
  });

  console.log(`[openapi] generated ${label} -> ${output}`);
}
