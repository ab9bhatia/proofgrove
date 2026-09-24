"use client";

import { useEffect, useRef } from "react";

import { groupingDecision } from "@/lib/bakeoff";
import { groupLaunch, refreshTargets } from "@/lib/bakeoff-grouping";
import { forgetLaunch, readLaunches, updateLaunch } from "@/lib/bakeoff-store";

/** Slow enough to be invisible, fast enough that a finished bakeoff groups promptly. */
const SWEEP_MS = 5000;

/** Give up on a launch after this many failed grouping attempts. */
const MAX_ATTEMPTS = 3;

/**
 * The single owner of bakeoff grouping.
 *
 * Runs cannot join a workspace until they finish, so a bakeoff's last step
 * routinely outlives the screen that started it — the user navigates away, or
 * closes the tab entirely. This mounts once for the whole app and sweeps the
 * persisted launches on a timer, grouping any whose runs have since finished.
 *
 * It sweeps repeatedly rather than once on mount: the root layout mounts
 * before any launch exists, so a single pass would never see one. The launcher
 * screen polls too, but only to show progress — grouping lives here alone so
 * two owners in one tab cannot race. Cross-tab, `groupLaunch` takes a lock.
 *
 * Renders nothing.
 */
export function BakeoffResume() {
  // Sweeps must not overlap: a slow one (many launches, or a slow `from-runs`)
  // would otherwise run alongside the next tick and re-enter grouping.
  const sweeping = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function sweep() {
      if (sweeping.current) return;
      sweeping.current = true;
      try {
        for (const launch of readLaunches()) {
          if (cancelled) return;
          if (launch.workspaceId || launch.groupingFailed) continue;

          const targets = await refreshTargets(launch.targets, launch.tenantId);
          if (cancelled) return;
          updateLaunch(launch.launchId, { targets });

          const decision = groupingDecision(targets);
          if (!decision.ready) {
            // Every run finished and fewer than two succeeded: this launch can
            // never produce a comparison, so stop carrying it forever.
            if (decision.reason === "too-few-completed") forgetLaunch(launch.launchId);
            continue;
          }

          try {
            await groupLaunch({ ...launch, targets });
          } catch {
            // Grouping can fail for reasons a retry will not fix (a basis
            // mismatch, a deleted run). Retry a few times, then let it go
            // rather than re-POSTing a non-idempotent call forever.
            const attempts = (launch.attempts ?? 0) + 1;
            if (attempts >= MAX_ATTEMPTS) updateLaunch(launch.launchId, { attempts, groupingFailed: true });
            else updateLaunch(launch.launchId, { attempts });
          }
        }
      } catch {
        // Best-effort and silent: the user did not ask for this on this page,
        // and the runs stay valid and groupable by hand either way.
      } finally {
        sweeping.current = false;
      }
    }

    const timer = window.setInterval(() => void sweep(), SWEEP_MS);
    void sweep();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
