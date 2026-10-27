import type { Client, EmbedBuilder } from "discord.js";
import { RESTJSONErrorCodes } from "discord.js";
import {
  getReportMark,
  listReportDestinations,
  markReportHandled,
  setReportRoleHolders,
  setReportRoles,
} from "../store/reportStore";
import type { ReportKind, ReportSettings } from "../store/reportStore";
import { logError, logInfo, logWarn } from "../utils/log";
import { REPORT_ALLOWED_MENTIONS, buildReportEmbed, periodLabel } from "../utils/reportEmbed";
import { isMockData } from "./riotData";
import { discordErrorCode, rotateWeeklyRoles, roleGuildFrom } from "./reportRoles";
import type { RoleGuild } from "./reportRoles";
import { latestDuePeriod, loadReport, nextReportDueAt } from "./reports";
import { isStopping } from "./shutdownState";

/** The longest the scheduler sleeps. A timer does not count time the computer slept, so waking checks again within a minute. */
export const REPORT_TICK_MS = 60_000;
const MIN_DELAY_MS = 1_000;
/** A send that keeps failing for a reason that may pass is retried on this many consecutive checks before the period is given up. */
export const MAX_SEND_ATTEMPTS = 3;

export interface ReportPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions: typeof REPORT_ALLOWED_MENTIONS;
}

/** The channel is gone, is not a text channel of this server, or the bot cannot reach it. */
export class ReportChannelError extends Error {
  constructor() {
    super("The report channel is missing or is not a text channel of this server.");
    this.name = "ReportChannelError";
  }
}

export interface ReportSchedulerDeps {
  now(): number;
  /** Which kind of records to report; the same switch the rest of the bot uses for mock and real data. */
  mock(): boolean;
  /** Posts to the guild's report channel. Throws when it cannot. */
  send(guildId: string, channelId: string, payload: ReportPayload): Promise<void>;
  /** The server for weekly roles, or null when the bot is no longer in it. */
  roleGuild(guildId: string): RoleGuild | null;
  stopped(): boolean;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Failures that retrying cannot fix: the report is dropped and logged once instead of being retried every minute. */
function isPermanent(error: unknown): boolean {
  if (error instanceof ReportChannelError) return true;
  const code = discordErrorCode(error);
  return code === RESTJSONErrorCodes.UnknownChannel || code === RESTJSONErrorCodes.UnknownGuild
    || code === RESTJSONErrorCodes.MissingAccess || code === RESTJSONErrorCodes.MissingPermissions;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown error");

export class ReportScheduler {
  private timer: unknown;
  private running: Promise<void> | undefined;
  private halted = false;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: ReportSchedulerDeps) {}

  /** Checks for due reports now (the catch-up after a restart), then keeps checking at every Pacific midnight. */
  start(): void {
    if (this.halted || this.running || this.timer !== undefined) return;
    this.tick();
  }

  /** Stops timing and waits for a check already in progress, so the database is never closed under it. */
  async stop(): Promise<void> {
    this.halted = true;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private tick(): void {
    this.timer = undefined;
    this.running = this.runDue().finally(() => {
      this.running = undefined;
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.halted || this.deps.stopped()) return;
    const now = this.deps.now();
    const delay = Math.min(Math.max(nextReportDueAt(now) - now, MIN_DELAY_MS), REPORT_TICK_MS);
    this.timer = this.deps.setTimer(() => { this.tick(); }, delay);
  }

  /** Posts every report that is due and has not been handled. Never throws: one server's failure leaves the others alone. */
  async runDue(): Promise<void> {
    let destinations: ReportSettings[];
    let mock: boolean;
    try {
      mock = this.deps.mock();
      destinations = listReportDestinations();
    } catch (error) {
      logError(`Report check failed: ${errorName(error)}`);
      return;
    }
    for (const settings of destinations) {
      if (this.halted || this.deps.stopped()) return;
      try {
        if (settings.dailyEnabled) await this.handle(settings, "day", mock);
        if (this.halted || this.deps.stopped()) return;
        if (settings.weeklyEnabled) await this.handle(settings, "week", mock);
      } catch (error) {
        logError(`Report for server ${settings.guildId} failed: ${errorName(error)}`);
      }
    }
  }

  private async handle(settings: ReportSettings, kind: ReportKind, mock: boolean): Promise<void> {
    const guildId = settings.guildId;
    const now = this.deps.now();
    // Only the newest finished period is ever considered, so a long outage never produces a flood of old reports.
    const range = latestDuePeriod(kind, now);
    const mark = getReportMark(guildId, mock, kind);
    if (mark !== undefined && mark >= range.start) return;

    const data = loadReport(guildId, kind, range, mock);
    if (data.totalGames === 0) {
      markReportHandled(guildId, mock, kind, range.start, now);
      return;
    }

    const key = `${guildId}:${mock ? 1 : 0}:${kind}:${range.start}`;
    try {
      await this.deps.send(guildId, settings.channelId!, { embeds: [buildReportEmbed(data, { final: true })], allowedMentions: REPORT_ALLOWED_MENTIONS });
    } catch (error) {
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      const giveUp = isPermanent(error) || attempt >= MAX_SEND_ATTEMPTS;
      logWarn(`Could not post the ${kind === "day" ? "daily" : "weekly"} 马报 for ${periodLabel(data)} in server ${guildId} (${errorName(error)}, code ${discordErrorCode(error) ?? "none"})${giveUp ? "; giving up on this period. Check the report channel and the bot's permissions there." : "; will retry."}`);
      if (giveUp) {
        markReportHandled(guildId, mock, kind, range.start, now);
        this.attempts.delete(key);
      }
      return;
    }
    this.attempts.delete(key);
    // Recorded right after the send so a restart never posts the same period twice.
    markReportHandled(guildId, mock, kind, range.start, now);
    logInfo(`Posted the ${kind === "day" ? "daily" : "weekly"} 马报 for ${periodLabel(data)} in server ${guildId}${mock ? " (mock data)" : ""}.`);

    if (kind === "week") await this.rotateRoles(settings, data.topHorse?.discordUserId ?? null, data.noneHorse?.discordUserId ?? null, mock);
  }

  /** Rotates the weekly roles after the report. Whatever goes wrong is logged and told to the admins once, and never reaches the caller. */
  private async rotateRoles(settings: ReportSettings, top: string | null, none: string | null, mock: boolean): Promise<void> {
    if (!settings.rolesEnabled || !settings.topRoleId || !settings.noneRoleId) return;
    // Roles reward real games. A mock rehearsal never changes who holds them.
    if (mock) {
      logInfo(`Weekly roles in server ${settings.guildId} were left alone because the bot runs on mock data.`);
      return;
    }
    const guildId = settings.guildId;
    let problems: string[];
    try {
      const guild = this.deps.roleGuild(guildId);
      if (!guild) {
        logWarn(`Weekly roles in server ${guildId} were not updated: the bot is no longer in that server.`);
        return;
      }
      const outcome = await rotateWeeklyRoles(guild, {
        topRoleId: settings.topRoleId,
        noneRoleId: settings.noneRoleId,
        topHolderIds: settings.topHolderIds,
        noneHolderIds: settings.noneHolderIds,
      }, { top, none });
      if (outcome.topRoleId !== settings.topRoleId || outcome.noneRoleId !== settings.noneRoleId) {
        setReportRoles(guildId, { enabled: true, topRoleId: outcome.topRoleId, noneRoleId: outcome.noneRoleId });
      }
      setReportRoleHolders(guildId, { top: outcome.topHolderIds, none: outcome.noneHolderIds });
      problems = outcome.problems;
    } catch (error) {
      logError(`Weekly roles in server ${guildId} failed: ${errorName(error)}`);
      problems = ["身份组更新时出了意外错误，详情见机器人日志。"];
    }
    if (problems.length === 0) return;
    logWarn(`Weekly roles in server ${guildId} were not fully updated: ${problems.join(" ")}`);
    const content = `⚠️ 本周的「本周特等马」「本周没有马」身份组没有更新完整，周报本身已正常发出：\n${problems.map((problem) => `- ${problem}`).join("\n")}\n管理员处理好之后，下周会自动恢复；也可以用 \`/report-settings roles\` 关闭这个功能。`;
    try {
      await this.deps.send(guildId, settings.channelId!, { content: content.slice(0, 1900), allowedMentions: REPORT_ALLOWED_MENTIONS });
    } catch (error) {
      logWarn(`Could not tell server ${guildId} about the weekly role problem (${errorName(error)}).`);
    }
  }
}

/** The real Discord side of the scheduler. */
export function discordSchedulerDeps(client: Client): ReportSchedulerDeps {
  return {
    now: () => Date.now(),
    mock: isMockData,
    async send(guildId, channelId, payload) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isSendable() || channel.isDMBased() || channel.guildId !== guildId) throw new ReportChannelError();
      await channel.send(payload);
    },
    roleGuild(guildId) {
      const guild = client.guilds.cache.get(guildId);
      return guild ? roleGuildFrom(guild) : null;
    },
    stopped: isStopping,
    // Unref'd: the Discord connection keeps the process alive, and a pending timer must never delay shutdown.
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
    clearTimer: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
  };
}

let active: ReportScheduler | undefined;

/** Starts the one scheduler of this process. A second call does nothing. */
export function startReportScheduler(client: Client): void {
  if (active) return;
  active = new ReportScheduler(discordSchedulerDeps(client));
  active.start();
}

/** Stops the scheduler and waits for a report in progress. Safe to call when it never started. */
export async function stopReportScheduler(): Promise<void> {
  const scheduler = active;
  active = undefined;
  await scheduler?.stop();
}
