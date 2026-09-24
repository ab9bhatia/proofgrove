export const SIDEBAR_PREFERENCE_KEY = "eval-hub:sidebar";

export function parseSidebarPreference(value: string | null) {
  if (value === "open") return true;
  if (value === "collapsed") return false;
  return null;
}

export function serializeSidebarPreference(open: boolean) {
  return open ? "open" : "collapsed";
}
