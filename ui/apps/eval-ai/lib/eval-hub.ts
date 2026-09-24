import "server-only";

const DEFAULT_EVAL_HUB_URL = "http://127.0.0.1:8010";

/** Base URL of the Proofgrove FastAPI backend (in-cluster service or local). */
export function evalHubBaseUrl(): string {
  return (process.env.EVAL_HUB_API_URL ?? DEFAULT_EVAL_HUB_URL).replace(/\/+$/, "");
}
