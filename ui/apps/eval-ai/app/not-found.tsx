import Link from "next/link";

export default function NotFound() {
  return <section aria-labelledby="not-found-title" className="mx-auto max-w-xl px-6 py-16">
    <h1 id="not-found-title" className="text-2xl font-semibold">Page not found</h1>
    <p className="mt-3 text-muted-foreground">This page may have moved, or the address may be incorrect.</p>
    <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium text-brand-text focus-visible:ring-2 focus-visible:ring-ring">Back to Overview</Link>
  </section>;
}
