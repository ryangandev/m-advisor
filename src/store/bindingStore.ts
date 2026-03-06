import { RiotAccount } from "../types";

interface ServerBinding {
  discordUserId: string;
  accounts: RiotAccount[];
}

const store = new Map<string, ServerBinding>();

export function getBinding(guildId: string): ServerBinding | undefined {
  return store.get(guildId);
}

export function setBinding(guildId: string, binding: ServerBinding): void {
  store.set(guildId, binding);
}

export function clearBinding(guildId: string): void {
  store.delete(guildId);
}
