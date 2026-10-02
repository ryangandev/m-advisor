import dotenv from "dotenv";
import { registerCommands } from "../handlers/commandHandler";

dotenv.config({ quiet: true });
void registerCommands().then(() => {
  console.log("Registered commands in the configured test server.");
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command registration failed.");
  process.exitCode = 1;
});
