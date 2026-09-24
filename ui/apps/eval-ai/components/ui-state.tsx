"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sessionAwareFetch } from "@evalai/shared/session";
import {
  parseSidebarPreference,
  serializeSidebarPreference,
  SIDEBAR_PREFERENCE_KEY,
} from "@/lib/ui-preferences";

interface UserResponse {
  firstName: string;
  lastName: string;
  email: string;
}

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  mobileNavOpen: boolean;
  openMobileNav: () => void;
  closeMobileNav: () => void;
  fullName: string;
  initials: string;
  /**
   * True only when a real signed-in identity has resolved from the gateway.
   * False while the placeholder ("User") fallback is in effect — governance
   * actions that record an audit actor must not proceed on the fallback.
   */
  identityResolved: boolean;
}

const UIStateContext = createContext<UIState | null>(null);

export function UIStateProvider({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [user, setUser] = useState<UserResponse | null>(null);
  const sidebarPreferenceLoaded = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = parseSidebarPreference(
        window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY),
      );
      if (saved !== null) setSidebarOpen(saved);
      sidebarPreferenceLoaded.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!sidebarPreferenceLoaded.current) return;
    window.localStorage.setItem(
      SIDEBAR_PREFERENCE_KEY,
      serializeSidebarPreference(sidebarOpen),
    );
  }, [sidebarOpen]);

  useEffect(() => {
    let cancelled = false;
    sessionAwareFetch("/api/user", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to resolve the current session");
        return response.json();
      })
      .then((data: UserResponse) => {
        if (!cancelled) setUser(data);
      })
      .catch(() => {
        // The fallback keeps local development usable without gateway identity.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  const firstName = user?.firstName?.trim() ?? "";
  const lastName = user?.lastName?.trim() ?? "";
  const email = user?.email?.trim() ?? "";
  const resolvedName = `${firstName} ${lastName}`.trim() || email;
  const identityResolved = Boolean(user) && resolvedName.length > 0;
  const fullName = resolvedName || "User";
  const initials =
    `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase() || "U";

  const value = useMemo(
    () => ({
      sidebarOpen,
      toggleSidebar,
      mobileNavOpen,
      openMobileNav,
      closeMobileNav,
      fullName,
      initials,
      identityResolved,
    }),
    [
      sidebarOpen,
      toggleSidebar,
      mobileNavOpen,
      openMobileNav,
      closeMobileNav,
      fullName,
      initials,
      identityResolved,
    ],
  );

  return (
    <UIStateContext.Provider value={value}>{children}</UIStateContext.Provider>
  );
}

export function useUIState(): UIState {
  const state = useContext(UIStateContext);
  if (!state) throw new Error("useUIState must be used within UIStateProvider");
  return state;
}
