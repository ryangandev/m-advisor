import { ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return interaction.inGuild() && (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false);
}
