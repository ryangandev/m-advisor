import { readFileSync } from "node:fs";
import dotenv from "dotenv";

/** Only the speech overrides: tokens and the Riot key in the same file must never reach an isolated verifier run. */
export function pickLocalTtsEnv(parsed: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith("LOCAL_TTS_")));
}

/**
 * Copies the `LOCAL_TTS_*` settings of an optional `.env` file into `target`, as the bot does, so the verifier measures the
 * speech runtime the bot uses. A variable already set in the environment wins, like `dotenv.config`. Returns the keys it set.
 */
export function loadLocalTtsEnv(file: string = ".env", target: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const set: string[] = [];
  for (const [key, value] of Object.entries(pickLocalTtsEnv(dotenv.parse(text)))) {
    if (target[key] !== undefined) continue;
    target[key] = value;
    set.push(key);
  }
  return set;
}
