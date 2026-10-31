import assert from "node:assert/strict";
import { test } from "node:test";
import championNames from "../src/data/championNamesZh.json";
import { championLabel as participantLabel } from "../src/services/announcementText";
import type { MatchParticipant } from "../src/types";
import { normalizeChampionName } from "../src/utils/championName";
import { championLabel as recordLabel } from "../src/utils/stableEmbed";

const RENATA_ID = 888;

test("normalizeChampionName closes the spaces around a middle dot and leaves other names alone", () => {
  assert.equal(normalizeChampionName("烈娜塔 · 戈拉斯克"), "烈娜塔·戈拉斯克");
  assert.equal(normalizeChampionName("奥瑞利安·索尔"), "奥瑞利安·索尔");
  assert.equal(normalizeChampionName("亚索"), "亚索");
});

test("no shipped champion label contains the ' · ' every text row uses as its separator", () => {
  const ids = Object.keys((championNames as { names: Record<string, string> }).names);
  assert.ok(ids.length > 150);
  for (const id of ids) {
    const participant = { championId: Number(id), championName: "Fallback" } as MatchParticipant;
    assert.ok(!participantLabel(participant).includes(" · "), `announcement label for ${id}`);
    assert.ok(!recordLabel({ championId: Number(id), championName: "Fallback" }).includes(" · "), `stable label for ${id}`);
  }
});

test("Renata reads as one name in both label functions", () => {
  assert.equal(participantLabel({ championId: RENATA_ID, championName: "Renata" } as MatchParticipant), "烈娜塔·戈拉斯克");
  assert.equal(recordLabel({ championId: RENATA_ID, championName: "Renata" }), "烈娜塔·戈拉斯克");
});
