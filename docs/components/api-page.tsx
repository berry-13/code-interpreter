'use client';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { createCodeUsageGeneratorRegistry } from 'fumadocs-openapi/requests/generators';
import { curl } from 'fumadocs-openapi/requests/generators/curl';
import { javascript } from 'fumadocs-openapi/requests/generators/javascript';
import { python } from 'fumadocs-openapi/requests/generators/python';

/**
 * Languages offered on the "example request" tabs. curl matches the shell
 * examples used throughout the guides; JavaScript and Python match how callers
 * actually integrate with this service.
 */
const codeUsages = createCodeUsageGeneratorRegistry();
codeUsages.add('curl', curl);
codeUsages.add('javascript', javascript);
codeUsages.add('python', python);

/**
 * Renderer for the auto-generated API reference pages. Wired into the MDX
 * component map in `app/docs/[[...slug]]/page.tsx`, where the page's OpenAPI
 * data is preloaded on the server first.
 */
export const OpenAPIPage = createOpenAPIPage({
  codeUsages,
});
