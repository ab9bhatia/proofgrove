/** W3C trace-context identifiers: zero is the disabled/invalid OTel sentinel. */
export function validTraceId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) && !/^0+$/.test(value) ? value : null;
}

export function validSpanId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9a-f]{16}$/i.test(value) && !/^0+$/.test(value) ? value : null;
}
