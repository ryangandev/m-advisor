const activeGuilds = new Set<string>();

/** A simulation must establish its baseline and announce its own match atomically. */
export async function withSimulationLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
  if (activeGuilds.has(guildId)) throw new Error("模拟测试正在进行，请等这次播报完成后再试。");
  activeGuilds.add(guildId);
  try { return await operation(); } finally { activeGuilds.delete(guildId); }
}
