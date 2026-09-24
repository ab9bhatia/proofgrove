// Stub for `server-only` so server modules can be loaded under vitest.
// In production this package throws when imported from a client bundle; under
// tests we don't care since we're not building a client bundle.
export {};
