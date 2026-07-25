'use client';

import { use, useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Renders the ```mermaid code fences in the docs.
 *
 * `remarkMdxMermaid` (wired in `source.config.ts`) rewrites those fences into
 * `<Mermaid chart="..." />`, and this component draws them client-side. It
 * cannot render on the server: mermaid measures text to lay out nodes, so it
 * needs a real DOM. Hence the mount gate below, which also keeps the static
 * export from emitting a diagram built against the wrong theme.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return <MermaidContent chart={chart} />;
}

/** Keyed promise cache so a diagram is only laid out once per theme. */
const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise('mermaid', () => import('mermaid')));

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'inherit',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: resolvedTheme === 'dark' ? 'dark' : 'default',
  });

  // `useId` returns a value containing colons, which are invalid in the CSS
  // selectors mermaid builds from the id it is given.
  const renderId = `mermaid-${id.replace(/[^a-zA-Z0-9]/g, '')}`;

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () => mermaid.render(renderId, chart)),
  );

  return (
    <div
      className="my-6 flex justify-center overflow-x-auto [&>svg]:max-w-full"
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
