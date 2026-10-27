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

/** Creating the pair of roles failed part-way: `partial` holds whichever role was found or created before the failure. */
export class RoleCreationError extends Error {
  constructor(readonly partial: { top: RoleLike | null; none: RoleLike | null }, readonly original: unknown) {
    super("The weekly roles could not all be created.");
    this.name = "RoleCreationError";
  }
}

/** An admin-facing explanation of a failed Discord call. The logs, not this text, carry anything technical. */
export function explainRoleFailure(error: unknown): string {
  const code = discordErrorCode(error instanceof RoleCreationError ? error.original : error);
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
 * When a step fails it throws a RoleCreationError that still carries the roles found or created before the failure,
 * so the caller can keep them instead of creating them again next time.
 */
export async function ensureWeeklyRoles(guild: RoleGuild, configured: { top: string | null; none: string | null }): Promise<{ top: RoleLike; none: RoleLike }> {
  let top: RoleLike | null = null;
  try {
    top = await ensureRole(guild, configured.top, TOP_ROLE_NAME);
    const none = await ensureRole(guild, configured.none, NONE_ROLE_NAME);
    return { top, none };
  } catch (error) {
    throw new RoleCreationError({ top, none: null }, error);
  }
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
  /** Everyone who shares the week's best average (usually one), or empty when nobody was named. */
  top: readonly string[];
  /** Everyone who shares the week's worst average (usually one), or empty when nobody was named. */
  none: readonly string[];
}

/** Takes the role from `previous` holders who are not among `winners` and gives it to every winner. Returns the holders now. */
async function rotateOne(guild: RoleGuild, roleId: string, previous: readonly string[], winners: readonly string[], problems: string[]): Promise<string[]> {
  const keep = new Set(winners);
  const holders: string[] = [];
  for (const userId of previous) {
    if (keep.has(userId)) { holders.push(userId); continue; }
    try {
      const member = await guild.fetchMember(userId);
      // A member who left no longer holds anything.
      if (member) await member.roles.remove(roleId, AUDIT_REASON);
    } catch (error) {
      // A role that no longer exists is held by nobody.
      if (discordErrorCode(error) === RESTJSONErrorCodes.UnknownRole) continue;
      problems.push(explainRoleFailure(error));
      // Keep the holder so the next rotation tries again.
      holders.push(userId);
    }
  }
  for (const winner of winners) {
    try {
      const member = await guild.fetchMember(winner);
      if (!member) {
        // Left the server: nothing to give, and nothing to remember.
        const index = holders.indexOf(winner);
        if (index >= 0) holders.splice(index, 1);
        continue;
      }
      // Also when already recorded as a holder, in case the role was removed by hand.
      await member.roles.add(roleId, AUDIT_REASON);
      if (!holders.includes(winner)) holders.push(winner);
    } catch (error) {
      problems.push(explainRoleFailure(error));
    }
  }
  return holders;
}

/** The holders of a role that is being replaced by another one belong to the old role and do not carry over. */
const holdersOfSameRole = (oldId: string, newId: string, holders: readonly string[]): readonly string[] => (oldId === newId ? holders : []);

/**
 * Gives the week's winners their roles and takes the roles back from last week's holders.
 * Tied winners all get the role. It creates a role that is missing and only ever touches the two configured roles and
 * the members the bot itself gave them to. Any Discord failure is collected in `problems` instead of thrown, so a report
 * is never blocked. With missing permissions or an unreachable role nothing is changed at all, except that roles which
 * were created before a failure are kept in the returned ids.
 */
export async function rotateWeeklyRoles(guild: RoleGuild, state: WeeklyRoleState, winners: WeeklyWinners): Promise<WeeklyRoleOutcome> {
  const unchanged: WeeklyRoleOutcome = { ...state, problems: [] };
  const check = await checkRoleSetup(guild).catch((error: unknown) => ({ ok: false, problems: [explainRoleFailure(error)] }));
  if (!check.ok) return { ...unchanged, problems: check.problems };
  const problems: string[] = [];
  const withIds = (top: RoleLike | null, none: RoleLike | null): WeeklyRoleState => {
    const topRoleId = top?.id ?? state.topRoleId;
    const noneRoleId = none?.id ?? state.noneRoleId;
    return {
      topRoleId,
      noneRoleId,
      topHolderIds: holdersOfSameRole(state.topRoleId, topRoleId, state.topHolderIds),
      noneHolderIds: holdersOfSameRole(state.noneRoleId, noneRoleId, state.noneHolderIds),
    };
  };
  try {
    const { top, none } = await ensureWeeklyRoles(guild, { top: state.topRoleId, none: state.noneRoleId });
    const ensured = withIds(top, none);
    const standing = (await guild.botStanding())!;
    if (top.position >= standing.highestRolePosition || none.position >= standing.highestRolePosition || top.managed || none.managed) {
      return { ...ensured, problems: [HIERARCHY_PROBLEM] };
    }
    const topHolderIds = await rotateOne(guild, top.id, ensured.topHolderIds, winners.top, problems);
    const noneHolderIds = await rotateOne(guild, none.id, ensured.noneHolderIds, winners.none, problems);
    return { topRoleId: top.id, noneRoleId: none.id, topHolderIds, noneHolderIds, problems: [...new Set(problems)] };
  } catch (error) {
    const partial = error instanceof RoleCreationError ? withIds(error.partial.top, error.partial.none) : unchanged;
    return { ...partial, problems: [explainRoleFailure(error)] };
  }
}

/**
 * Takes one role back from the members the bot gave it to. A role that no longer exists counts as already released.
 * Returns the holders that still have it, which is only the ones Discord refused to change.
 */
export async function releaseRoleHolders(guild: RoleGuild, roleId: string, holders: readonly string[]): Promise<{ holders: string[]; problems: string[] }> {
  if (holders.length === 0) return { holders: [], problems: [] };
  try {
    if (!(await guild.fetchRole(roleId))) return { holders: [], problems: [] };
  } catch (error) {
    return { holders: [...holders], problems: [explainRoleFailure(error)] };
  }
  const problems: string[] = [];
  const left = await rotateOne(guild, roleId, holders, [], problems);
  return { holders: left, problems: [...new Set(problems)] };
}

/** Takes both roles back from the members the bot gave them to, for turning the feature off. Returns what is still held. */
export async function releaseWeeklyRoles(guild: RoleGuild, state: WeeklyRoleState): Promise<WeeklyRoleOutcome> {
  const top = await releaseRoleHolders(guild, state.topRoleId, state.topHolderIds);
  const none = await releaseRoleHolders(guild, state.noneRoleId, state.noneHolderIds);
  return { ...state, topHolderIds: top.holders, noneHolderIds: none.holders, problems: [...new Set([...top.problems, ...none.problems])] };
}
