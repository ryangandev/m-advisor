import { REST, Routes } from "discord.js";

const LEGACY_NAMES = new Set(["announcer", "bind", "bindings", "profile", "testvc", "unbind"]);
type RegistryApi = Pick<REST, "get" | "delete">;
interface CommandRecord { id: string; name: string; type: number }

/** Retire known global controls only after replacement and single-guild scope are verified. */
export async function retireLegacyGlobalCommands(
  api: RegistryApi,
  applicationId: string,
  authorizedGuildId: string,
  replacementNames: readonly string[],
): Promise<string[]> {
  if (![applicationId, authorizedGuildId].every(id => /^\d{17,20}$/.test(id))) {
    throw new Error("Global command migration requires valid application and authorized guild IDs.");
  }
  if (!replacementNames.length || new Set(replacementNames).size !== replacementNames.length) {
    throw new Error("Global command migration requires a nonempty, unique replacement manifest.");
  }
  const guilds = await api.get(Routes.userGuilds());
  if (!Array.isArray(guilds) || guilds.length !== 1 || guilds[0]?.id !== authorizedGuildId) {
    throw new Error("Global migration refused: the bot must belong only to the authorized test server. Use guild registration without migration for multiple servers.");
  }
  const registered = await api.get(Routes.applicationGuildCommands(applicationId, authorizedGuildId));
  if (!Array.isArray(registered)) throw new Error("Unexpected guild command response; global commands were not changed.");
  const available = new Set(registered.filter(command => command.type === 1).map(command => command.name));
  if (replacementNames.some(name => !available.has(name))) {
    throw new Error("Global migration refused: register and verify all replacement guild commands first.");
  }
  const globals = await api.get(Routes.applicationCommands(applicationId));
  if (!Array.isArray(globals)) throw new Error("Unexpected global command response; global commands were not changed.");
  const candidates = globals.filter(command => command.type === 1 && LEGACY_NAMES.has(command.name)) as CommandRecord[];
  // Check the entire plan before the first mutation, including the legacy test's replacement.
  for (const command of candidates) {
    if (!/^\d{17,20}$/.test(command.id)) throw new Error("Unexpected legacy command identifier; global commands were not changed.");
    const replacement = command.name === "testvc" ? "testvoice" : command.name;
    if (!replacementNames.includes(replacement)) throw new Error("Global migration refused: a legacy command has no registered replacement.");
  }
  const retired: string[] = [];
  for (const command of candidates) {
    await api.delete(Routes.applicationCommand(applicationId, command.id));
    retired.push(command.name);
  }
  return retired;
}
