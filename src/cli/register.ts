import dotenv from "dotenv";
import { registerCommands } from "../handlers/commandHandler";
import { REST } from "discord.js";
import { retireLegacyGlobalCommands } from "../services/commandMigration";

dotenv.config({ quiet: true });
async function register(): Promise<void> {
  const extra = process.argv.slice(2);
  if (extra.some(argument => argument !== "--migrate-legacy-globals")) throw new Error("Unknown registration argument. Supported option: --migrate-legacy-globals.");
  const names = await registerCommands();
  console.log("Registered commands in the configured test server.");
  if (extra.includes("--migrate-legacy-globals")) {
    const api = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);
    const retired = await retireLegacyGlobalCommands(api, process.env.CLIENT_ID!, process.env.TEST_GUILD_ID!.trim(), names);
    console.log(`Retired ${retired.length} known legacy global commands: ${retired.join(", ") || "none"}.`);
  }
}
void register().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command registration failed.");
  process.exitCode = 1;
});
