import type { Client, Guild, VoiceState } from "discord.js";
import type { TrackedMember } from "../types";
import { listAllTracking, listTrackedMembers } from "../store/bindingStore";
import { stopPolling, syncMonitoring } from "./gameMonitor";
import { isStopping } from "./shutdownState";
import { logError } from "../utils/log";

export interface LifecycleDependencies {
  members: (guildId: string) => TrackedMember[];
  sync: (client: Client, guildId: string, presentMemberIds: string[]) => void;
  stop: (guildId: string, reason: string) => void;
  stopping: () => boolean;
  log: (message: string) => void;
}

/** Keeps each guild's monitoring session in step with which tracked members are in voice. */
export class MonitorLifecycle {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: LifecycleDependencies) {}

  /**
   * Read every tracked member's voice state and sync the session to it.
   * Calls for one guild run one after another, so a slow lookup can never apply an older view over a newer one.
   */
  reconcile(client: Client, guildId: string): Promise<void> {
    const previous = this.chains.get(guildId) ?? Promise.resolve();
    const next = previous.then(() => this.apply(client, guildId)).catch((error: unknown) => {
      this.dependencies.log(`Monitoring reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    this.chains.set(guildId, next);
    void next.finally(() => { if (this.chains.get(guildId) === next) this.chains.delete(guildId); });
    return next;
  }

  async restore(client: Client): Promise<void> {
    for (const { guildId } of listAllTracking()) {
      if (this.dependencies.stopping()) return;
      await this.reconcile(client, guildId);
    }
  }

  /** Joins, leaves and moves of a tracked member reconcile; mute, deafen and untracked members are ignored. */
  voiceStateChanged(oldState: VoiceState, newState: VoiceState): Promise<void> | undefined {
    if (oldState.channelId === newState.channelId) return undefined;
    const guildId = newState.guild.id;
    const userId = newState.id;
    if (!this.dependencies.members(guildId).some((member) => member.discordUserId === userId)) return undefined;
    return this.reconcile(newState.client, guildId);
  }

  /**
   * A guild that comes back after a gateway re-identify has reloaded its voice states without any VoiceStateUpdate,
   * so the session is read against the real voice states again.
   */
  guildAvailable(guild: Guild): Promise<void> {
    return this.reconcile(guild.client, guild.id);
  }

  private async apply(client: Client, guildId: string): Promise<void> {
    if (this.dependencies.stopping()) return;
    const members = this.dependencies.members(guildId);
    const guild = client.guilds.cache.get(guildId);
    if (members.length === 0 || !guild) {
      this.dependencies.stop(guildId, guild ? "there is no tracked member in this server" : "the bot cannot see this server");
      return;
    }
    const states = await Promise.all(members.map((member) =>
      guild.members.fetch(member.discordUserId).catch(() => null)));
    if (this.dependencies.stopping()) return;
    const present = members.filter((_, index) => Boolean(states[index]?.voice.channelId)).map((member) => member.discordUserId);
    this.dependencies.sync(client, guildId, present);
  }
}

const lifecycle = new MonitorLifecycle({
  members: listTrackedMembers,
  sync: syncMonitoring,
  stop: stopPolling,
  stopping: isStopping,
  log: logError,
});

export function reconcileGuildMonitoring(client: Client, guildId: string): Promise<void> {
  return lifecycle.reconcile(client, guildId);
}

export function restoreMonitoring(client: Client): Promise<void> {
  return lifecycle.restore(client);
}

export function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> | undefined {
  return lifecycle.voiceStateChanged(oldState, newState);
}

export function handleGuildAvailable(guild: Guild): Promise<void> {
  return lifecycle.guildAvailable(guild);
}
