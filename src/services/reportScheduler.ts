import { createHash } from "node:crypto";
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
import { catchUpPeriods, latestDuePeriod, loadReport, nextReportDueAt } from "./reports";
import type { ReportData } from "./reports";
import { isStopping } from "./shutdownState";

/** The longest the scheduler sleeps. A timer does not count time the computer slept, so waking checks again within a minute. */
export const REPORT_TICK_MS = 60_000;
const MIN_DELAY_MS = 1_000;
/**
 * How long a send may keep failing before the period is given up.
 * Measured from the first failure in this process, so a Mac that wakes without Wi-Fi for a few minutes, or a Discord
 * outage, never drops a period, while a problem that never clears does not retry forever.
 * Time the computer slept does not count: see FAILURE_GAP_RESET_MS.
 */
export const GIVE_UP_AFTER_MS = 6 * 3_600_000;
/**
 * A failed retry this long after the previous failed attempt means the process was asleep in between (checks come at
 * least every REPORT_TICK_MS while awake), so the failure clock restarts instead of counting the sleep.
 */
export const FAILURE_GAP_RESET_MS = 5 * REPORT_TICK_MS;
/** How long shutdown waits for a report that is being sent before it closes the database anyway. */
export const SHUTDOWN_WAIT_MS = 3_000;

export interface ReportPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions: typeof REPORT_ALLOWED_MENTIONS;
  /**
   * A fixed id for this exact report, sent with `enforceNonce` so that Discord returns the first message instead of
   * posting a second when a request is repeated after a timeout. Discord only remembers a nonce for a few minutes, so
   * restarts are covered by the stored marks and not by this.
   */
  nonce?: string;
}

/** The nonce of one report: the same server, data mode, kind and period always give the same value, at most 25 characters. */
export function reportNonce(guildId: string, mock: boolean, kind: ReportKind, periodStart: number): string {
  return createHash("sha256").update(`m-advisor:report:${guildId}:${mock ? 1 : 0}:${kind}:${periodStart}`).digest("hex").slice(0, 24);
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
  /**
   * Whether the bot is still in the server. A removed server is skipped. A Discord outage keeps the server in the cache,
   * so only a real removal answers false.
   */
  inGuild(guildId: string): boolean;
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
const kindName = (kind: ReportKind) => (kind === "day" ? "daily" : "weekly");

export class ReportScheduler {
  private timer: unknown;
  private running: Promise<void> | undefined;
  private halted = false;
  /** When each period's send first failed in this process (after the last sleep) and when it last failed. */
  private readonly firstFailure = new Map<string, { first: number; last: number }>();
  /** Servers already logged as skipped because the bot is not in them. */
  private readonly skippedGuilds = new Set<string>();
  /**
   * Per server, data mode and kind, the latest period start this process settled but could not mark in the database.
   * It acts like a stored mark: the effective mark is the larger of the two, so nothing at or before it is touched again.
   */
  private readonly settledMarks = new Map<string, number>();

  constructor(private readonly deps: ReportSchedulerDeps) {}

  /** Checks for due reports now (the catch-up after a restart), then keeps checking at every Pacific midnight. */
  start(): void {
    if (this.halted || this.running || this.timer !== undefined) return;
    this.tick();
  }

  /** Stops timing and prevents any new work, without waiting for anything. A check in progress notices at its next step. */
  halt(): void {
    this.halted = true;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Halts, then waits for a check in progress for at most `timeoutMs`, so the database is not closed under it for long. */
  async stop(timeoutMs = SHUTDOWN_WAIT_MS): Promise<void> {
    this.halt();
    const running = this.running;
    if (!running) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timeout);
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

  private get stopping(): boolean {
    return this.halted || this.deps.stopped();
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
      if (this.stopping) return;
      try {
        if (!this.deps.inGuild(settings.guildId)) {
          this.noteSkipped(settings.guildId);
          continue;
        }
        this.skippedGuilds.delete(settings.guildId);
        if (settings.dailyEnabled) await this.handle(settings, "day", mock);
        if (this.stopping) return;
        if (settings.weeklyEnabled) await this.handle(settings, "week", mock);
      } catch (error) {
        logError(`Report for server ${settings.guildId} failed: ${errorName(error)}`);
      }
    }
  }

  /** Said once per server and process; the destination stays stored, so the reports resume if the bot is added back. */
  private noteSkipped(guildId: string): void {
    if (this.skippedGuilds.has(guildId)) return;
    this.skippedGuilds.add(guildId);
    logInfo(`Skipping the 马报 of server ${guildId}: the bot is not in that server.`);
  }

  /**
   * Records that a period is done. If the database refuses, the period is remembered in memory instead, so a successful
   * post is never repeated every minute; after a restart the mark is missing and the period could post once more.
   */
  private settle(guildId: string, mock: boolean, kind: ReportKind, periodStart: number, now: number): void {
    try {
      markReportHandled(guildId, mock, kind, periodStart, now);
    } catch (error) {
      const memoryKey = `${guildId}:${mock ? 1 : 0}:${kind}`;
      this.settledMarks.set(memoryKey, Math.max(this.settledMarks.get(memoryKey) ?? periodStart, periodStart));
      logError(`Could not record the ${kindName(kind)} 马报 of server ${guildId} as handled (${errorName(error)}); it will not be touched again until the bot restarts.`);
    }
  }

  private async handle(settings: ReportSettings, kind: ReportKind, mock: boolean): Promise<void> {
    const guildId = settings.guildId;
    const now = this.deps.now();
    // The latest finished period is the one that gets marked. The report posted may be an older missed period that has
    // games (see catchUpPeriods), but never more than one post per kind per check, so an outage never floods the channel.
    const latest = latestDuePeriod(kind, now);
    const storedMark = getReportMark(guildId, mock, kind);
    const memoryMark = this.settledMarks.get(`${guildId}:${mock ? 1 : 0}:${kind}`);
    const mark = storedMark === undefined || memoryMark === undefined ? (storedMark ?? memoryMark) : Math.max(storedMark, memoryMark);
    if (mark !== undefined && mark >= latest.start) return;

    // Newest first: the first period with games is the one posted.
    let data: ReportData | undefined;
    for (const range of catchUpPeriods(kind, now, mark)) {
      const loaded = loadReport(guildId, kind, range, mock);
      if (loaded.totalGames > 0) { data = loaded; break; }
    }
    if (!data) {
      this.settle(guildId, mock, kind, latest.start, now);
      // Nothing is posted for an empty week, but its roles still move on: last week's holders lose them and nobody gains any.
      if (kind === "week") await this.rotateRoles(settings, [], [], mock, { quiet: true });
      return;
    }
    const posted = data;
    const key = `${guildId}:${mock ? 1 : 0}:${kind}:${posted.range.start}`;

    if (this.stopping) return;
    // Roles follow the latest finished week. When that week had no games and an older one is posted, nobody earns the
    // roles, so the old holders lose them now: whether the older report ever gets through must not decide that.
    // The report itself never mentions roles, so it stays true either way. A retry finds no holders and does nothing.
    const current = posted.range.start === latest.start;
    if (kind === "week" && !current) {
      await this.rotateRoles(settings, [], [], mock, { quiet: true });
      if (this.stopping) return;
    }
    try {
      await this.deps.send(guildId, settings.channelId!, {
        embeds: [buildReportEmbed(posted, { final: true })],
        allowedMentions: REPORT_ALLOWED_MENTIONS,
        nonce: reportNonce(guildId, mock, kind, posted.range.start),
      });
    } catch (error) {
      // The bot was removed while the send was in flight, so Discord answers 50001 or 10003. That is not a problem with
      // the channel: leave the period open and forget its failure clock, so the normal catch-up posts it after a re-add.
      if (!this.deps.inGuild(guildId)) {
        this.firstFailure.delete(key);
        this.noteSkipped(guildId);
        return;
      }
      // A failure is stamped when the send has failed, and the gap is measured from that to the start of the next
      // attempt, so a send that hangs for minutes before failing never looks like a sleep.
      const failedAt = this.deps.now();
      const previous = this.firstFailure.get(key);
      // A gap far longer than the tick means the process was asleep, so the failure clock restarts: only time spent
      // awake and failing counts toward giving up.
      const awake = previous !== undefined && now - previous.last <= FAILURE_GAP_RESET_MS;
      const first = awake ? previous.first : failedAt;
      this.firstFailure.set(key, { first, last: failedAt });
      const giveUp = isPermanent(error) || (previous !== undefined && failedAt - first >= GIVE_UP_AFTER_MS);
      // One line when the trouble starts and one when the period is dropped; the retries in between stay quiet.
      if (previous === undefined || giveUp) {
        logWarn(`Could not post the ${kindName(kind)} 马报 for ${periodLabel(posted)} in server ${guildId} (${errorName(error)}, code ${discordErrorCode(error) ?? "none"})${giveUp ? "; giving up on this period. Check the report channel and the bot's permissions there." : "; will keep retrying."}`);
      }
      if (giveUp) {
        this.firstFailure.delete(key);
        this.settle(guildId, mock, kind, latest.start, now);
      }
      return;
    }
    this.firstFailure.delete(key);
    // Recorded right after the send so a restart never posts the same period twice.
    this.settle(guildId, mock, kind, latest.start, now);
    logInfo(`Posted the ${kindName(kind)} 马报 for ${periodLabel(posted)} in server ${guildId}${mock ? " (mock data)" : ""}.`);

    if (kind === "week" && current) {
      await this.rotateRoles(settings, posted.topHorses.map((member) => member.discordUserId), posted.noneHorses.map((member) => member.discordUserId), mock, { quiet: false });
    }
  }

  /**
   * Rotates the weekly roles after the report. Whatever goes wrong is logged and, unless `quiet`, told to the admins once;
   * it never reaches the caller.
   */
  private async rotateRoles(settings: ReportSettings, top: readonly string[], none: readonly string[], mock: boolean, options: { quiet: boolean }): Promise<void> {
    if (!settings.rolesEnabled || !settings.topRoleId || !settings.noneRoleId) return;
    // Nothing to take back from an empty week when nobody holds a role.
    if (options.quiet && settings.topHolderIds.length === 0 && settings.noneHolderIds.length === 0) return;
    // Roles reward real games. A mock rehearsal never changes who holds them.
    if (mock) {
      if (!options.quiet) logInfo(`Weekly roles in server ${settings.guildId} were left alone because the bot runs on mock data.`);
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
    if (options.quiet || this.stopping) return;
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
      const { nonce, ...message } = payload;
      await channel.send(nonce === undefined ? message : { ...message, nonce, enforceNonce: true });
    },
    roleGuild(guildId) {
      const guild = client.guilds.cache.get(guildId);
      return guild ? roleGuildFrom(guild) : null;
    },
    inGuild: (guildId) => client.guilds.cache.has(guildId),
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

/** First step of shutdown: no new check or send starts. It does not wait for anything. */
export function haltReportScheduler(): void {
  active?.halt();
}

/** Last step before the database closes: waits briefly for a report still being sent. Safe when it never started. */
export async function finishReportScheduler(timeoutMs = SHUTDOWN_WAIT_MS): Promise<void> {
  const scheduler = active;
  active = undefined;
  await scheduler?.stop(timeoutMs);
}
