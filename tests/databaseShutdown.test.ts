import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

/**
 * Runs `body` in a fresh process, because shutting the database down is irreversible for the process.
 * The body runs with a temporary DATABASE_PATH and returns the object to report; `directory` and `databasePath` are in scope.
 */
function runInFreshProcess(body: string): Record<string, unknown> {
  const root = path.resolve(__dirname, "..");
  const code = String.raw`
const root = ${JSON.stringify(root)};
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "database-shutdown-test-"));
const databasePath = path.join(directory, "bot.sqlite3");
process.env.DATABASE_PATH = databasePath;
process.env.RIOT_MODE = "mock";
(async () => {
  try {
    const result = await (async () => { ${body} })();
    console.log(JSON.stringify(result));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: root, encoding: "utf8", timeout: 10_000 });
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

test("after shutdownDatabase, getDatabase throws instead of reopening, and the old connection stays closed", () => {
  const result = runInFreshProcess(String.raw`
const database = require(root + "/src/store/database.ts");
const connection = database.getDatabase();
database.shutdownDatabase();
let thrown;
try { database.getDatabase(); } catch (error) { thrown = error; }
database.shutdownDatabase();
return { open: connection.open, name: thrown?.name, message: thrown?.message,
  isClosedError: thrown instanceof database.DatabaseClosedError };
`);
  assert.equal(result.open, false);
  assert.equal(result.name, "DatabaseClosedError");
  assert.equal(result.isClosedError, true);
  assert.match(String(result.message), /database is closed/);
});

test("a store call after shutdownDatabase fails with DatabaseClosedError and creates no database file", () => {
  const result = runInFreshProcess(String.raw`
const database = require(root + "/src/store/database.ts");
const appeals = require(root + "/src/store/appealStore.ts");
database.shutdownDatabase();
let thrown;
try { appeals.isAppealClosed({ guildId: "guild", discordUserId: "member", matchId: "NA1_1", mock: true }); } catch (error) { thrown = error; }
return { name: thrown?.name, fileCreated: fs.existsSync(databasePath) };
`);
  assert.equal(result.name, "DatabaseClosedError");
  assert.equal(result.fileCreated, false, "a late call must not create or migrate a database");
});

test("closeDatabase alone still lets tests and scripts reopen the same file", () => {
  const result = runInFreshProcess(String.raw`
const database = require(root + "/src/store/database.ts");
const first = database.getDatabase();
database.closeDatabase();
const second = database.getDatabase();
const reopened = second !== first && second.open;
database.closeDatabase();
return { reopened };
`);
  assert.equal(result.reopened, true);
});

test("a command that reaches the store after shutdown gets the usual private error reply and no unhandled rejection", () => {
  const result = runInFreshProcess(String.raw`
const database = require(root + "/src/store/database.ts");
const appeals = require(root + "/src/store/appealStore.ts");
const handler = require(root + "/src/events/interactionCreate.ts").default;
const errors = [];
console.error = line => { errors.push(String(line)); };
const unhandled = [];
process.on("unhandledRejection", reason => unhandled.push(String(reason)));
const replies = [];
const interaction = {
  commandName: "late", replied: false, deferred: true,
  client: { commands: new Map([["late", { execute: async () => {
    // The command was waiting on a slow lookup while the bot shut down.
    await new Promise(resolve => setTimeout(resolve, 20));
    appeals.isAppealClosed({ guildId: "guild", discordUserId: "member", matchId: "NA1_1", mock: true });
  } }]]) },
  isChatInputCommand: () => true, isAutocomplete: () => false, isButton: () => false,
  reply: async payload => { replies.push({ via: "reply", payload }); },
  editReply: async payload => { replies.push({ via: "editReply", payload }); },
  followUp: async payload => { replies.push({ via: "followUp", payload }); },
};
const pending = handler.execute(interaction);
database.shutdownDatabase();
await pending;
await new Promise(resolve => setTimeout(resolve, 20));
return { unhandled, errors, replies: replies.map(item => ({ via: item.via, description: item.payload.embeds?.[0]?.data?.description })) };
`);
  assert.deepEqual(result.unhandled, []);
  assert.equal((result.errors as string[]).length, 1);
  assert.match((result.errors as string[])[0], /Command execution failed for \/late: DatabaseClosedError$/);
  assert.deepEqual(result.replies, [{ via: "editReply", description: "Something went wrong while handling that command." }]);
});
