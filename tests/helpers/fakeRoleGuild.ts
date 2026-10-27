import type { BotStanding, MemberLike, RoleGuild, RoleLike } from "../../src/services/reportRoles";

export function discordError(code: number, message = "Discord refused"): Error {
  return Object.assign(new Error(message), { name: "DiscordAPIError", code });
}

/** A Discord server in memory: roles with positions, members with role sets, and a log of every change made. */
export class FakeRoleGuild implements RoleGuild {
  id = "guild-roles";
  standing: BotStanding | null = { manageRoles: true, highestRolePosition: 10 };
  roles = new Map<string, RoleLike & { name: string }>();
  /** Role IDs held by each member. A user who is absent has left the server. */
  members = new Map<string, Set<string>>();
  /** Every mutation in order, for example `add:role-top:alice`, so tests can assert that nothing else was touched. */
  changes: string[] = [];
  /** Throws this for the matching operation, e.g. { add: error }. */
  failures: Partial<Record<"add" | "remove" | "create" | "standing" | "fetchRole" | "fetchMember", Error>> = {};
  /** How many roles may be created before creation starts failing; unlimited when undefined. */
  createLimit: number | undefined;
  private created = 0;

  addRole(id: string, name: string, position = 1, managed = false): void {
    this.roles.set(id, { id, name, position, managed });
  }

  addMember(userId: string, roleIds: string[] = []): void {
    this.members.set(userId, new Set(roleIds));
  }

  async botStanding(): Promise<BotStanding | null> {
    if (this.failures.standing) throw this.failures.standing;
    return this.standing;
  }

  async fetchRole(roleId: string): Promise<RoleLike | null> {
    if (this.failures.fetchRole) throw this.failures.fetchRole;
    return this.roles.get(roleId) ?? null;
  }

  async createRole(name: string, _reason?: string): Promise<RoleLike> {
    if (this.failures.create) throw this.failures.create;
    if (this.createLimit !== undefined && this.created >= this.createLimit) throw discordError(50013, "Missing Permissions");
    this.created += 1;
    const role = { id: `created-${this.created}`, name, position: 1, managed: false };
    this.roles.set(role.id, role);
    this.changes.push(`create:${name}`);
    return role;
  }

  async fetchMember(userId: string): Promise<MemberLike | null> {
    if (this.failures.fetchMember) throw this.failures.fetchMember;
    const held = this.members.get(userId);
    if (!held) return null;
    return {
      roles: {
        add: async (roleId) => {
          if (this.failures.add) throw this.failures.add;
          held.add(roleId);
          this.changes.push(`add:${roleId}:${userId}`);
        },
        remove: async (roleId) => {
          if (this.failures.remove) throw this.failures.remove;
          held.delete(roleId);
          this.changes.push(`remove:${roleId}:${userId}`);
        },
      },
    };
  }
}
