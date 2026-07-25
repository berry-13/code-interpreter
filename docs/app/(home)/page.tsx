import Link from 'next/link';
import { ArrowRight, Boxes, FileCode2, ShieldCheck, Wrench } from 'lucide-react';
import { gitConfig } from '@/lib/shared';

const features = [
  {
    icon: ShieldCheck,
    title: 'Real isolation',
    body: 'A libkrun microVM with its own guest kernel, NsJail inside it, a seccomp deny-list, cgroups, and an empty network namespace.',
  },
  {
    icon: FileCode2,
    title: 'Files in and out',
    body: 'Callers upload inputs, code reads and writes them, artifacts come back — through S3-compatible storage, namespaced per user.',
  },
  {
    icon: Wrench,
    title: 'Tool calling',
    body: 'Sandboxed programs pause, call back into your tools, and resume with the results. Your tools never run in the sandbox.',
  },
  {
    icon: Boxes,
    title: 'Scales horizontally',
    body: 'API, workers, file server, and gateway are separate services over Redis and object storage, each scaling on its own.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-5xl flex-col px-4 py-20 md:py-28">
        <p className="mb-4 text-sm font-medium tracking-wide text-fd-muted-foreground">
          Sandboxed code execution for LibreChat
        </p>
        <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Run untrusted code without trusting it
        </h1>
        <p className="mt-6 max-w-2xl text-balance text-lg text-fd-muted-foreground">
          Code Interpreter executes model-generated programs inside a microVM
          with its own kernel, hands them no network and no credentials, and
          returns their output and files. Self-hostable with Docker Compose or
          Helm.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/docs/guides/quickstart"
            className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Quickstart
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/docs/developers/architecture"
            className="inline-flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            How it works
          </Link>
          <a
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            GitHub
          </a>
        </div>

        <div className="mt-14 overflow-x-auto rounded-xl border bg-fd-card p-5">
          <pre className="text-sm leading-relaxed">
            <code>
              <span className="text-fd-muted-foreground">
                # bring up the full stack
              </span>
              {'\n'}CODEAPI_LANGUAGES=python docker compose up --build{'\n\n'}
              <span className="text-fd-muted-foreground"># run something</span>
              {'\n'}curl -sX POST localhost:3112/v1/exec \{'\n'}
              {'  '}-H &apos;Content-Type: application/json&apos; \{'\n'}
              {'  '}-d &apos;{'{"lang":"py","code":"print(sum(range(10)))"}'}&apos;
            </code>
          </pre>
        </div>
      </section>

      <section className="border-t bg-fd-card/30">
        <div className="mx-auto grid w-full max-w-5xl gap-px px-4 py-16 sm:grid-cols-2">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="p-5">
              <Icon className="mb-3 size-5 text-fd-muted-foreground" />
              <h2 className="mb-1.5 font-semibold">{title}</h2>
              <p className="text-sm text-fd-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-4 py-16">
        <h2 className="text-xl font-semibold">Start reading</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Link
            href="/docs/guides/quickstart"
            className="rounded-xl border p-5 transition-colors hover:bg-fd-accent"
          >
            <h3 className="mb-1.5 font-medium">Guides</h3>
            <p className="text-sm text-fd-muted-foreground">
              Install, configure, integrate, and operate the service.
            </p>
          </Link>
          <Link
            href="/docs/reference"
            className="rounded-xl border p-5 transition-colors hover:bg-fd-accent"
          >
            <h3 className="mb-1.5 font-medium">API reference</h3>
            <p className="text-sm text-fd-muted-foreground">
              Every endpoint, generated from the OpenAPI specs.
            </p>
          </Link>
          <Link
            href="/docs/developers/architecture"
            className="rounded-xl border p-5 transition-colors hover:bg-fd-accent"
          >
            <h3 className="mb-1.5 font-medium">Developers</h3>
            <p className="text-sm text-fd-muted-foreground">
              Architecture, the security model, and contributing.
            </p>
          </Link>
        </div>
      </section>
    </main>
  );
}
