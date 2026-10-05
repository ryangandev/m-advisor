import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** Daily log files kept, counting today. */
export const LOG_RETENTION_DAYS = 14;
const LOG_FILE = /^bot-(\d{4}-\d{2}-\d{2})\.log$/;

export type LogLevel = "INFO" | "WARN" | "ERROR";

interface FileLog {
  directory: string;
  now: () => Date;
  day?: string;
  failing: boolean;
}

let fileLog: FileLog | undefined;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Local time with milliseconds and UTC offset, so lines from different days and zones stay unambiguous. */
function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${localDay(date)}T${localTime(date)}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Credentials never reach the terminal or a log file, even if an error message quotes them. */
function redact(message: string): string {
  let result = message;
  for (const name of ["DISCORD_TOKEN", "RIOT_API_KEY"]) {
    const secret = process.env[name]?.trim();
    if (secret && secret.length >= 8) result = result.replaceAll(secret, `[${name}]`);
  }
  return result;
}

export function getLogDirectory(): string {
  return path.resolve(process.env.BOT_DATA_DIR?.trim() || ".data", "logs");
}

/** Removes daily files older than the retention window; other files in the directory are left alone. */
function prune(state: FileLog, today: Date): void {
  const cutoff = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (LOG_RETENTION_DAYS - 1)));
  for (const name of readdirSync(state.directory)) {
    const day = LOG_FILE.exec(name)?.[1];
    if (day && day < cutoff) rmSync(path.join(state.directory, name), { force: true });
  }
}

function writeFile(state: FileLog, level: LogLevel, message: string, at: Date): void {
  try {
    const day = localDay(at);
    if (day !== state.day) {
      mkdirSync(state.directory, { recursive: true, mode: 0o700 });
      prune(state, at);
      state.day = day;
    }
    appendFileSync(path.join(state.directory, `bot-${day}.log`), `${localTimestamp(at)} ${level} ${message}\n`, { mode: 0o600 });
    state.failing = false;
  } catch (error) {
    state.day = undefined;
    // One warning per failure streak; the terminal keeps every message meanwhile.
    if (!state.failing) {
      state.failing = true;
      console.error(`[${localTime(at)}] Log file write failed: ${error instanceof Error ? error.message : "unknown error"}; logging continues in the terminal only.`);
    }
  }
}

function write(level: LogLevel, message: string, terminal: boolean): void {
  const state = fileLog;
  const at = state?.now() ?? new Date();
  const text = redact(message);
  if (terminal) {
    const line = `[${localTime(at)}] ${text}`;
    if (level === "INFO") console.log(line);
    else console.error(line);
  }
  if (state) writeFile(state, level, text, at);
}

export function logInfo(message: string): void { write("INFO", message, true); }
export function logWarn(message: string): void { write("WARN", message, true); }
export function logError(message: string): void { write("ERROR", message, true); }

/** For output Node already printed to the terminal, such as a process warning or a fatal error. */
export function logToFileOnly(level: LogLevel, message: string): void { write(level, message, false); }

/**
 * Also appends every message to one file per local day under `directory` and prunes old days.
 * Only the bot entry point enables this, so tests and one-off scripts never write log files.
 */
export function startFileLog(options: { directory?: string; now?: () => Date } = {}): string {
  const directory = options.directory ?? getLogDirectory();
  fileLog = { directory, now: options.now ?? (() => new Date()), failing: false };
  return directory;
}

export function stopFileLog(): void {
  fileLog = undefined;
}
