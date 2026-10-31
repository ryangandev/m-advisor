import { after, before } from "node:test";
import { useRiotPacer } from "../../src/services/riotData";
import { RiotPacer } from "../../src/services/riotPacing";

/**
 * Replaces the shared Riot pacer with one without windows for the whole test file. Its tests send many requests to a
 * fake Riot on the real clock, and the real pacer would make the 17th wait 1.2 s and refuse a requester with a tiny
 * timeout. Pacing itself is tested in riotPacing.test.ts and recentPacing.test.ts.
 */
export function withoutRiotPacing(): void {
  let restore: (() => void) | undefined;
  before(() => { restore = useRiotPacer(new RiotPacer({ windows: [] })); });
  after(() => { restore?.(); });
}
