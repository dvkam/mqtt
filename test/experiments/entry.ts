/** The entry at `index`, counted from the end when negative. A missing entry fails the test at the read. */
export function entryAt<Entry>(entries: readonly Entry[], index: number): Entry {
  const entry = entries.at(index);
  if (entry === undefined) throw new Error('No entry at index ' + index);
  return entry;
}
