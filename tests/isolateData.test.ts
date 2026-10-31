import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDatabasePath } from "../src/store/database";
import { getLogDirectory } from "../src/utils/log";

test("the default database and log directory of a test process are a temporary directory, never the repo's .data", () => {
  const repoData = path.resolve(__dirname, "..", ".data");
  const tmp = path.resolve(os.tmpdir());
  for (const target of [getDatabasePath(), getLogDirectory()]) {
    assert.ok(!path.resolve(target).startsWith(repoData + path.sep), `${target} is inside the repo's .data`);
    assert.ok(path.resolve(target).startsWith(tmp + path.sep), `${target} is not under the temporary directory`);
  }
});
