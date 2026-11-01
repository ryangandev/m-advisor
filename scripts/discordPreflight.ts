import { PermissionFlagsBits } from "discord.js";

/**
 * What the live verifier needs in the authorized voice channel: it joins and speaks, posts embed reports and reads them back.
 * Checked before anything visible is posted, so a missing permission is refused up front.
 */
export const REQUIRED_CHANNEL_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.Connect, label: "Connect" },
  { flag: PermissionFlagsBits.Speak, label: "Speak" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
] as const;

export function requiredPermissionBits(): bigint[] {
  return REQUIRED_CHANNEL_PERMISSIONS.map(permission => permission.flag);
}

export function missingPermissionsMessage(): string {
  const labels = REQUIRED_CHANNEL_PERMISSIONS.map(permission => permission.label);
  return `The bot needs ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]} in the authorized channel.`;
}
