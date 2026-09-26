import "server-only";

const DEFAULT_PROOFGROVE_URL = "http://127.0.0.1:8010";

/** Base URL of the Proofgrove FastAPI backend (in-cluster service or local). */
export function proofgroveBaseUrl(): string {
  return (process.env.PROOFGROVE_API_URL ?? DEFAULT_PROOFGROVE_URL).replace(/\/+$/, "");
}
