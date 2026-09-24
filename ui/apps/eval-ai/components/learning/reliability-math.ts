/** Teaching probabilities under independent, identical Bernoulli trials. */
export function reliability(p: number, count: number) {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isInteger(count) || count < 1) {
    throw new RangeError("Use a probability from 0 to 1 and a positive integer count.");
  }
  return { all: p ** count, atLeastOne: 1 - (1 - p) ** count };
}

export const asPercent = (value: number) => {
  // Rounded extreme probabilities must not imply certainty or impossibility.
  if (value > .9999) return ">99.99%";
  if (value >= .9995) return ">99.9%";
  if (value > 0 && value < .0005) return "<0.1%";
  return `${(value * 100).toFixed(1)}%`;
};
