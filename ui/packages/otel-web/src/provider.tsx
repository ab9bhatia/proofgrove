"use client";

// Client component that starts telemetry once the app has mounted.
//
// The OTel browser SDK is ~46 KB gzipped (measured on the pilot app), which is
// too much to put in the initial bundle for something no user is waiting on.
// `./init` is therefore loaded with a dynamic import inside an effect, so the
// bundler emits it as a separate chunk that is fetched after first paint. A
// static import here would defeat that: the effect would still run late, but
// the bytes would already have been downloaded and parsed on the critical path.

import { useEffect } from "react";
import type { TelemetryClientConfig } from "./config";

export interface TelemetryProviderProps {
  /** Resolved server-side by `resolveTelemetryConfig` and passed as a prop. */
  config: TelemetryClientConfig;
  /** Next App Router templates for this app. */
  routeTemplates: readonly string[];
}

/**
 * Mount once, high in the tree — typically in the root layout.
 *
 * Renders nothing. When telemetry is disabled the effect returns before the
 * dynamic import is reached, so a disabled app never downloads the SDK at all
 * and the component can stay mounted unconditionally.
 */
export function TelemetryProvider({
  config,
  routeTemplates,
}: TelemetryProviderProps): null {
  useEffect(() => {
    if (!config.enabled) return;

    let teardown: (() => void) | undefined;
    let cancelled = false;

    void import("./init")
      .then(({ initTelemetry }) => {
        // The component may have unmounted while the chunk was in flight.
        if (cancelled) return;
        teardown = initTelemetry({ config, routeTemplates });
      })
      .catch(() => {
        // A failed telemetry chunk must never surface to the user.
      });

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [config, routeTemplates]);

  return null;
}
