const tails = new Map<string, Promise<void>>();

/**
 * Runs operations for one server one after another, in the order they were asked for. A failed operation rejects only
 * its own caller; the next one still runs, and it starts only after the previous one finished, so it reads fresh state.
 */
export function runInGuildQueue<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(guildId) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(guildId, tail);
  void tail.then(() => { if (tails.get(guildId) === tail) tails.delete(guildId); });
  return result;
}
