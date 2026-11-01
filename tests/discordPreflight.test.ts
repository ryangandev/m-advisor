import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { missingPermissionsMessage, requiredPermissionBits } from "../scripts/discordPreflight";

test("the verify:discord preflight requires every permission it uses", () => {
  const bits = requiredPermissionBits();
  assert.ok(new PermissionsBitField(bits).has(bits));
  for (const flag of [PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) {
    assert.ok(bits.includes(flag));
    const without = new PermissionsBitField(bits.filter(bit => bit !== flag));
    assert.equal(without.has(bits), false, "a channel missing one of them is refused");
  }
});

test("the refusal names every required permission", () => {
  assert.equal(missingPermissionsMessage(), "The bot needs View Channel, Connect, Speak, Send Messages, Embed Links and Read Message History in the authorized channel.");
});
