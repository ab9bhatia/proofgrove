export const SESSION_STATUS_HEADER = "X-EvalAI-Session-Status";
export const SESSION_REJECTED_STATUS = "rejected";

let logoutStarted = false;

/** True only for the explicit response contract emitted by the session guard. */
export function isSessionGuardRejection(response: Response): boolean {
  return (
    response.status === 401 &&
    response.headers.get(SESSION_STATUS_HEADER) === SESSION_REJECTED_STATUS
  );
}

function isSameOrigin(input: RequestInfo | URL, location: Location): boolean {
  const target = input instanceof Request ? input.url : input.toString();
  try {
    return new URL(target, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Browser fetch wrapper that enters the gateway logout flow when the session
 * guard rejects a same-origin API request. The original response is preserved.
 */
export async function sessionAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (
    typeof window !== "undefined" &&
    isSameOrigin(input, window.location) &&
    isSessionGuardRejection(response) &&
    !logoutStarted
  ) {
    logoutStarted = true;
    window.location.replace("/logout");
  }
  return response;
}
