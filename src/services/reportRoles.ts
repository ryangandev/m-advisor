import { PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import type { Guild } from "discord.js";

export const TOP_ROLE_NAME = "本周特等马";
export const NONE_ROLE_NAME = "本周没有马";
const AUDIT_REASON = "策马军师每周马报";

/** The little of a Discord role the rotation needs. */
export interface RoleLike { id: string; position: number; managed: boolean }
export interface MemberLike {
  roles: {
    add(roleId: string, reason?: string): Promise<unknown>;
    remove(roleId: string, reason?: string): Promise<unknown>;
  };
}
/** What the bot may do in the server. Null means the bot's own membership could not be found. */
export interface BotStanding { manageRoles: boolean; highestRolePosition: number }

/** The few Discord operations the weekly roles use, so tests can replace Discord with a fake. */
export interface RoleGuild {
  id: string;
  botStanding(): Promise<BotStanding | null>;
  /** The role, or null when it no longer exists. */
  fetchRole(roleId: string): Promise<RoleLike | null>;
  createRole(name: string, reason: string): Promise<RoleLike>;
  /** The member, or null when they left the server. */
  fetchMember(userId: string): Promise<MemberLike | null>;
}

export function discordErrorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "number"
    ? (error as { code: number }).code : undefined;
}

/** Adapts a discord.js server to the narrow interface. A missing role or member is reported as null instead of an error. */
export function roleGuildFrom(guild: Guild): RoleGuild {
  const orNull = async <T>(operation: () => Promise<T>, missing: number): Promise<T | null> => {
    try { return await operation(); }
    catch (error) {
      if (discordErrorCode(error) === missing) return null;
      throw error;
    }
  };
  return {
    id: guild.id,
    async botStanding() {
      const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      return me ? { manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles), highestRolePosition: me.roles.highest.position } : null;
    },
    fetchRole: (roleId) => orNull(async () => (await guild.roles.fetch(roleId)) ?? null, RESTJSONErrorCodes.UnknownRole),
    createRole: (name, reason) => guild.roles.create({ name, reason, permissions: [], mentionable: false, hoist: false }),
    fetchMember: (userId) => orNull(() => guild.members.fetch(userId), RESTJSONErrorCodes.UnknownMember),
  };
}

export const MISSING_MANAGE_ROLES = "机器人没有「管理身份组」(Manage Roles) 权限。请在 服务器设置 → 身份组 里给机器人的身份组打开这一项。";
export const HIERARCHY_PROBLEM = `机器人的最高身份组必须排在「${TOP_ROLE_NAME}」和「${NONE_ROLE_NAME}」之上，否则 Discord 不允许它分配。请在 服务器设置 → 身份组 里把机器人的身份组拖到这两个身份组上面。`;

/** An admin-facing explanation of a failed Discord call. The logs, not this text, carry anything technical. */
export function explainRoleFailure(error: unknown): string {
  const code = discordErrorCode(error);
  if (code === RESTJSONErrorCodes.MissingPermissions || code === RESTJSONErrorCodes.MissingAccess) return `Discord 拒绝了身份组操作：机器人缺少权限，或身份组位置太低。${HIERARCHY_PROBLEM}`;
  if (code === RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached) return "服务器的身份组数量已到上限，机器人建不了新身份组。请删掉不用的身份组，或用 /report-settings roles 指定已有的身份组。";
  return "Discord 拒绝了这次身份组操作，详情见机器人日志。";
}

export interface RoleCheck {
  ok: boolean;
  /** Everything the admin has to fix, in plain Chinese. Empty when ok. */
  problems: string[];
}

/**
 * A dry run: checks that the bot may manage roles and, for roles that already exist, that it ranks above them.
 * It changes nothing in the server. Roles that do not exist yet are fine; they will be created below the bot.
 */
export async function checkRoleSetup(guild: RoleGuild, existingRoleIds: readonly string[] = []): Promise<RoleCheck> {
  const problems: string[] = [];
  const standing = await guild.botStanding();
  if (!standing) problems.push("找不到机器人自己在这个服务器里的成员信息，请确认机器人还在服务器里。");
  else if (!standing.manageRoles) problems.push(MISSING_MANAGE_ROLES);
  else {
    for (const roleId of existingRoleIds) {
      const role = await guild.fetchRole(roleId);
      if (!role) problems.push(`找不到身份组 <@&${roleId}>，它可能已被删除。`);
      else if (role.id === guild.id) problems.push("不能使用 @everyone 作为每周身份组。");
      else if (role.managed) problems.push(`<@&${roleId}> 是由机器人或集成管理的身份组，不能手动分配。`);
      else if (role.position >= standing.highestRolePosition) problems.push(`<@&${roleId}> 的位置不低于机器人的最高身份组，机器人无法分配它。请把机器人的身份组拖到它上面。`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Finds the configured role or creates it, so a deleted role is replaced instead of failing every week. */
async function ensureRole(guild: RoleGuild, configuredId: string | null, name: string): Promise<RoleLike> {
  if (configuredId) {
    const existing = await guild.fetchRole(configuredId);
    if (existing) return existing;
  }
  return guild.createRole(name, AUDIT_REASON);
}

/**
 * Reuses the configured weekly roles and creates whichever is missing, named 本周特等马 and 本周没有马 with no permissions.
 * Throws the Discord error when creation fails; callers turn it into an admin explanation.
 */
export async function ensureWeeklyRoles(guild: RoleGuild, configured: { top: string | null; none: string | null }): Promise<{ top: RoleLike; none: RoleLike }> {
  const top = await ensureRole(guild, configured.top, TOP_ROLE_NAME);
  const none = await ensureRole(guild, configured.none, NONE_ROLE_NAME);
  return { top, none };
}

export interface WeeklyRoleState {
  topRoleId: string;
  noneRoleId: string;
  topHolderIds: readonly string[];
  noneHolderIds: readonly string[];
}

export interface WeeklyRoleOutcome extends WeeklyRoleState {
  /** Plain-Chinese problems for the admin, in the order they happened. Empty when everything worked. */
  problems: string[];
}

export interface WeeklyWinners {
  /** The week's 特等马, or null when nobody was named. */
  top: string | null;
  /** The week's 没有马, or null when nobody was named. */
  none: string | null;
}

/** Takes the role from `previous` holders who no longer deserve it and gives it to `winner`. Returns the holders now. */
async function rotateOne(guild: RoleGuild, roleId: string, previous: readonly string[], winner: string | null, problems: string[]): Promise<string[]> {
  const holders: string[] = [];
  for (const userId of previous) {
    if (userId === winner) { holders.push(userId); continue; }
    try {
      const member = await guild.fetchMember(userId);
      // A member who left no longer holds anything.
      if (member) await member.roles.remove(roleId, AUDIT_REASON);
    } catch (error) {
      problems.push(explainRoleFailure(error));
      // Keep the holder so the next rotation tries again.
      holders.push(userId);
    }
  }
  if (winner && !holders.includes(winner)) {
    try {
      const member = await guild.fetchMember(winner);
      if (member) {
        await member.roles.add(roleId, AUDIT_REASON);
        holders.push(winner);
      }
    } catch (error) {
      problems.push(explainRoleFailure(error));
    }
  } else if (winner) {
    // Already recorded as holder: make sure Discord agrees, in case the role was removed by hand.
    try { await (await guild.fetchMember(winner))?.roles.add(roleId, AUDIT_REASON); }
    catch (error) { problems.push(explainRoleFailure(error)); }
  }
  return holders;
}

/**
 * Gives the week's winners their roles and takes the roles back from last week's holders.
 * It creates a role that is missing and only ever touches the two configured roles and the members the bot itself
 * gave them to. Any Discord failure is collected in `problems` instead of thrown, so a report is never blocked.
 * With missing permissions or an unreachable role nothing is changed at all.
 */
export async function rotateWeeklyRoles(guild: RoleGuild, state: WeeklyRoleState, winners: WeeklyWinners): Promise<WeeklyRoleOutcome> {
  const unchanged: WeeklyRoleOutcome = { ...state, problems: [] };
  const check = await checkRoleSetup(guild).catch((error: unknown) => ({ ok: false, problems: [explainRoleFailure(error)] }));
  if (!check.ok) return { ...unchanged, problems: check.problems };
  const problems: string[] = [];
  try {
    const { top, none } = await ensureWeeklyRoles(guild, { top: state.topRoleId, none: state.noneRoleId });
    const standing = (await guild.botStanding())!;
    if (top.position >= standing.highestRolePosition || none.position >= standing.highestRolePosition || top.managed || none.managed) {
      return { ...unchanged, problems: [HIERARCHY_PROBLEM] };
    }
    const topHolderIds = await rotateOne(guild, top.id, state.topHolderIds, winners.top, problems);
    const noneHolderIds = await rotateOne(guild, none.id, state.noneHolderIds, winners.none, problems);
    return { topRoleId: top.id, noneRoleId: none.id, topHolderIds, noneHolderIds, problems: [...new Set(problems)] };
  } catch (error) {
    return { ...unchanged, problems: [explainRoleFailure(error)] };
  }
}

/** Takes both roles back from the members the bot gave them to, for turning the feature off. Returns what is still held. */
export async function releaseWeeklyRoles(guild: RoleGuild, state: WeeklyRoleState): Promise<WeeklyRoleOutcome> {
  const problems: string[] = [];
  const topHolderIds = await rotateOne(guild, state.topRoleId, state.topHolderIds, null, problems);
  const noneHolderIds = await rotateOne(guild, state.noneRoleId, state.noneHolderIds, null, problems);
  return { ...state, topHolderIds, noneHolderIds, problems: [...new Set(problems)] };
}
