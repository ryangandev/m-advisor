import { Client, VoiceChannel } from "discord.js";
import type { MatchDetail, ServerBinding } from "../types";
import { getBinding } from "../store/bindingStore";
import {
  getAnnouncerState,
  getLastMatchId,
  resetAnnouncerRuntime,
  setActiveVoiceChannel,
  setLastMatchId,
  setPollingInterval,
} from "../store/announcerStore";
import { getLatestSRMatchId, getMatchDetail } from "../utils/riotMatchApi";
import { getRiotMode, RiotApiError } from "./riotData";
import { buildMatchAnnouncement } from "./announcementText";
import { buildHorseReportEmbed } from "../utils/embeds";
import { AnnouncementCancelledError, announceTextToCurrentChannel } from "./voiceAnnouncements";
import { logError, logInfo } from "../utils/log";

export const POLL_INTERVAL_MS = 45_000;
export interface PollResult { announced: number; errors: number }

/** What /recent shows about a guild's monitoring; the last error survives the session that raised it. */
export interface MonitorStatus {
  active: boolean;
  startedAt?: number;
  lastPollAt?: number;
  lastError?: { message: string; at: number };
  announced: ReadonlySet<string>;
}

export interface MonitorDependencies {
  latest: (puuid: string) => Promise<string | null>;
  detail: (matchId: string) => Promise<MatchDetail>;
  binding: typeof getBinding;
  resolveChannel: (client: Client, guildId: string, userId: string) => VoiceChannel | null;
  announce: typeof announceTextToCurrentChannel;
  mock: () => boolean;
  log: (error: unknown) => void;
  /** Progress messages for the operator, such as a newly detected match. */
  info: (message: string) => void;
}

interface MonitorSession {
  signature: string;
  startedAt: number;
  lastPollAt?: number;
  controller: AbortController;
  initialized: Set<string>;
  announced: Set<string>;
  skippedMockAccounts: Set<string>;
  inFlight?: Promise<PollResult>;
  inFlightTargets?: Set<string>;
}

function bindingSignature(binding: ServerBinding): string {
  return JSON.stringify([binding.discordUserId, ...binding.accounts.map((account) => account.puuid).sort()]);
}

function riotIds(binding: ServerBinding): string {
  return binding.accounts.map((account) => `${account.gameName}#${account.tagLine}`).join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Public lifecycle with injectable I/O so tests exercise complete polling sessions. */
export class GameMonitor {
  private readonly sessions = new Map<string, MonitorSession>();
  private readonly lastErrors = new Map<string, { message: string; at: number }>();

  constructor(private readonly dependencies: MonitorDependencies) {}

  start(client: Client, guildId: string, channelId: string): void {
    const binding = this.dependencies.binding(guildId);
    if (!binding) return;
    const signature = bindingSignature(binding);
    const existing = this.sessions.get(guildId);
    setActiveVoiceChannel(guildId, channelId);
    if (existing?.signature === signature) return;
    if (existing) this.stop(guildId, "the binding changed");
    resetAnnouncerRuntime(guildId);
    setActiveVoiceChannel(guildId, channelId);
    const channelName = (client.channels?.cache.get(channelId) as { name?: string } | undefined)?.name;
    this.dependencies.info(`Monitoring started for ${riotIds(binding)} in voice channel ${channelName ?? channelId}; `
      + `checking every ${POLL_INTERVAL_MS / 1000} s.`);
    this.sessions.set(guildId, {
      signature,
      startedAt: Date.now(),
      controller: new AbortController(),
      initialized: new Set(),
      announced: new Set(),
      skippedMockAccounts: new Set(),
    });
    const interval = setInterval(() => { void this.poll(client, guildId); }, POLL_INTERVAL_MS);
    interval.unref();
    setPollingInterval(guildId, interval);
    void this.poll(client, guildId);
  }

  stop(guildId: string, reason = "monitoring was stopped"): void {
    const session = this.sessions.get(guildId);
    session?.controller.abort(new AnnouncementCancelledError());
    this.sessions.delete(guildId);
    resetAnnouncerRuntime(guildId);
    if (session) this.dependencies.info(`Monitoring stopped: ${reason}.`);
  }

  stopAll(): void {
    for (const guildId of this.sessions.keys()) this.stop(guildId, "the bot is shutting down");
  }

  status(guildId: string): MonitorStatus {
    const session = this.sessions.get(guildId);
    return {
      active: Boolean(session),
      startedAt: session?.startedAt,
      lastPollAt: session?.lastPollAt,
      lastError: this.lastErrors.get(guildId),
      announced: new Set(session?.announced),
    };
  }

  private report(guildId: string, error: unknown): void {
    this.lastErrors.set(guildId, { message: errorMessage(error), at: Date.now() });
    this.dependencies.log(error);
  }

  poll(client: Client, guildId: string, requiredVoiceChannelId?: string): Promise<PollResult> {
    const session = this.sessions.get(guildId);
    if (!session) return Promise.resolve({ announced: 0, errors: 0 });
    if (session.inFlight) {
      if (requiredVoiceChannelId) session.inFlightTargets?.add(requiredVoiceChannelId);
      return session.inFlight;
    }
    const targets = new Set(requiredVoiceChannelId ? [requiredVoiceChannelId] : []);
    session.inFlightTargets = targets;
    const poll = this.run(client, guildId, session, targets).finally(() => {
      if (session.inFlight === poll) {
        session.inFlight = undefined;
        session.inFlightTargets = undefined;
      }
    });
    session.inFlight = poll;
    return poll;
  }

  private current(guildId: string, session: MonitorSession): boolean {
    if (this.sessions.get(guildId) !== session || session.controller.signal.aborted) return false;
    const binding = this.dependencies.binding(guildId);
    return Boolean(binding && bindingSignature(binding) === session.signature);
  }

  private async run(client: Client, guildId: string, session: MonitorSession, requiredTargets: Set<string>): Promise<PollResult> {
    const result = { announced: 0, errors: 0 };
    try {
      const binding = this.dependencies.binding(guildId);
      if (!binding || !this.current(guildId, session)) {
        if (this.sessions.get(guildId) === session) this.stop(guildId, "the binding was removed or changed");
        return result;
      }
      const attempted = new Set<string>();
      const accounts = [...new Map(binding.accounts.map((account) => [account.puuid, account])).values()];
      for (const account of accounts) {
        if (!this.current(guildId, session)) break;
        if (!this.dependencies.mock() && account.puuid.startsWith("MOCK-")) {
          if (!session.skippedMockAccounts.has(account.puuid)) {
            session.skippedMockAccounts.add(account.puuid);
            result.errors++;
            this.report(guildId, new Error(`The mock account ${account.gameName}#${account.tagLine} was skipped in real mode. `
              + "Use /bind with a real Riot ID to replace it."));
          }
          continue;
        }
        try {
          const matchId = await this.dependencies.latest(account.puuid);
          if (!this.current(guildId, session)) break;
          if (!session.initialized.has(account.puuid)) {
            // null is a valid baseline for an account with no SR match history.
            session.initialized.add(account.puuid);
            if (matchId) setLastMatchId(guildId, account.puuid, matchId);
            this.dependencies.info(`Baseline for ${account.gameName}#${account.tagLine}: ${matchId ?? "no Summoner's Rift history"}; `
              + "only matches that finish after this are announced.");
            continue;
          }
          if (!matchId || matchId === getLastMatchId(guildId, account.puuid)) continue;
          if (session.announced.has(matchId)) {
            setLastMatchId(guildId, account.puuid, matchId);
            continue;
          }
          if (attempted.has(matchId)) continue;
          attempted.add(matchId);
          const detail = await this.dependencies.detail(matchId);
          if (!this.current(guildId, session)) break;
          const detectedAt = Date.now();
          const ended = detail.info.gameEndTimestamp === null
            ? "end time unknown" : `ended ${Math.round((detectedAt - detail.info.gameEndTimestamp) / 1000)} s ago`;
          this.dependencies.info(`Detected finished match ${matchId} for ${account.gameName}#${account.tagLine}: ${ended}, `
            + `queue ${detail.info.queueId}, ${Math.round(detail.info.gameDuration / 60)} min.`);
          const { speech: text, report } = buildMatchAnnouncement(detail, account.puuid, this.dependencies.mock());
          const resolveTarget = () => {
            const currentChannel = this.dependencies.resolveChannel(client, guildId, binding.discordUserId);
            if (!currentChannel || [...requiredTargets].some((id) => currentChannel.id !== id)) return null;
            return currentChannel;
          };
          const channel = await this.dependencies.announce(
            guildId,
            text,
            getAnnouncerState(guildId).voiceStyle,
            resolveTarget,
            () => this.current(guildId, session) && Boolean(resolveTarget()),
            session.controller.signal,
          );
          if (!this.current(guildId, session)) break;
          // Failed TTS/transport leaves the baseline untouched so the next poll retries.
          session.announced.add(matchId);
          if (session.announced.size > 200) session.announced.delete(session.announced.values().next().value!);
          setLastMatchId(guildId, account.puuid, matchId);
          result.announced++;
          this.dependencies.info(`Announced match ${matchId} in voice ${Math.round((Date.now() - detectedAt) / 1000)} s after detection.`);
          const mappedParticipant = detail.info.participants.some((participant) =>
            binding.accounts.some((boundAccount) => boundAccount.puuid === participant.puuid));
          const mention = mappedParticipant && channel.members.has(binding.discordUserId) ? binding.discordUserId : undefined;
          try {
            await channel.send({
              ...(mention ? { content: `<@${mention}>` } : {}),
              embeds: [buildHorseReportEmbed(report)],
              allowedMentions: { parse: [], roles: [], users: mention ? [mention] : [], repliedUser: false },
            });
          } catch (error) {
            // Audio has already succeeded; retrying the match would repeat the voice announcement.
            result.errors++;
            this.report(guildId, error);
          }
        } catch (error) {
          if (error instanceof AnnouncementCancelledError || session.controller.signal.aborted || !this.current(guildId, session)) continue;
          result.errors++;
          this.report(guildId, error);
          if (error instanceof RiotApiError && ["missing_key", "unauthorized", "forbidden", "invalid_mode"].includes(error.code)) {
            // Credential/configuration failures need a deliberate restart, not a timer retry loop.
            this.stop(guildId, "Riot rejected the credentials or configuration; fix .env and restart the bot");
            break;
          }
        }
      }
    } catch (error) {
      result.errors++;
      this.report(guildId, error);
    } finally {
      session.lastPollAt = Date.now();
      if (result.errors === 0) this.lastErrors.delete(guildId);
    }
    return result;
  }
}

export function resolveMonitoredVoiceChannel(client: Client, guildId: string, userId: string): VoiceChannel | null {
  const channel = client.guilds.cache.get(guildId)?.members.cache.get(userId)?.voice.channel;
  if (!(channel instanceof VoiceChannel)) return null;
  if (getRiotMode() === "mock") {
    const testGuildId = process.env.TEST_GUILD_ID?.trim();
    const testChannelId = process.env.TEST_VOICE_CHANNEL_ID?.trim();
    if ((testGuildId && guildId !== testGuildId) || (testChannelId && channel.id !== testChannelId)) return null;
  }
  return channel;
}

const monitor = new GameMonitor({
  latest: getLatestSRMatchId,
  detail: getMatchDetail,
  binding: getBinding,
  resolveChannel: resolveMonitoredVoiceChannel,
  announce: announceTextToCurrentChannel,
  mock: () => getRiotMode() === "mock",
  log: (error) => logError(`Match monitoring failed: ${errorMessage(error)}`),
  info: logInfo,
});

export function startPolling(client: Client, guildId: string, voiceChannelId: string): void {
  monitor.start(client, guildId, voiceChannelId);
}

export function stopPolling(guildId: string, reason?: string): void {
  monitor.stop(guildId, reason);
}

export function getMonitorStatus(guildId: string): MonitorStatus {
  return monitor.status(guildId);
}

export function pollGuildNow(client: Client, guildId: string, requiredVoiceChannelId?: string): Promise<PollResult> {
  return monitor.poll(client, guildId, requiredVoiceChannelId);
}

export function stopAllPolling(): void {
  monitor.stopAll();
}
