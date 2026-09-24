# Proofgrove UI

Standalone classroom UI. From the project root, use the provided setup and launch scripts to start both the local API and UI.

For UI development only:

```sh
cd ui
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:3010/learn. The server proxy targets http://127.0.0.1:8010 and uses `POD_NAMESPACE=tenant-local-classroom`. Copy `.env.local.example` to `.env.local` if launching without the project scripts.

The complete application workflow remains available. The local judge is simulated and never establishes real model quality. External providers, hosted agents, and live tracing need additional integration. No sign-in or cloud API keys are needed for the local demonstration.

Validation: `pnpm typecheck`, `pnpm test`, and `pnpm build` from `ui/`.
