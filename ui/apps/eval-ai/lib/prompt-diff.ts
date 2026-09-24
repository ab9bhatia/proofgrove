export type PromptDiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Line comparison; keeps original whitespace and bounds work for large rewrites. */
export function diffPromptLines(before: string, after: string): PromptDiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const left = a.slice(start, a.length - end);
  const right = b.slice(start, b.length - end);
  const result: PromptDiffLine[] = a.slice(0, start).map(text => ({ kind: "same", text }));
  // ponytail: cap LCS at one million cells; large rewrites show the entire changed block.
  if ((left.length + 1) * (right.length + 1) > 1_000_000) {
    result.push(...left.map(text => ({ kind: "removed" as const, text })), ...right.map(text => ({ kind: "added" as const, text })));
  } else {
    const width = right.length + 1;
    const lengths = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        lengths[i * width + j] = left[i] === right[j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        result.push({ kind: "same", text: left[i++] }); j++;
      } else if (i < left.length && (j === right.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        result.push({ kind: "removed", text: left[i++] });
      } else {
        result.push({ kind: "added", text: right[j++] });
      }
    }
  }
  result.push(...a.slice(a.length - end).map(text => ({ kind: "same" as const, text })));
  return result;
}
