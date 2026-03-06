import { ChatInputCommandInteraction } from "discord.js";

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has("Administrator") ?? false;
}
