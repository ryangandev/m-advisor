import { readableName, seededChooser } from "./announcementText";
import type { HorseTier } from "./horseRanking";

/** The extra field on the finished report's horse embed. Text only: the spoken report never carries it. */
export const RECAP_FIELD_NAME = "锦囊回顾";

type Phrase = (name: string) => string;

/**
 * Wording by the pick's tier in this match. The joke is always on the 军师, never on the player:
 * a bad result is the 军师 admitting a misjudgement. Play-only wording, no em dash.
 */
export const RECAP_PHRASES: Readonly<Record<HorseTier, readonly Phrase[]>> = {
  特等马: [
    (name) => `军师点名的${name}本局特等马，料事如神。`,
    (name) => `军师点名的${name}果然是本局特等马，这一卦准得很。`,
    (name) => `军师点名的${name}本局拿下特等马，军师料事如神，请记下这一功。`,
  ],
  上等马: [
    (name) => `军师点名的${name}本局上等马，这一卦算是稳稳站住了。`,
    (name) => `军师点名的${name}本局是上等马，军师的眼光没有辜负。`,
    (name) => `军师点名的${name}本局上等马，虽然差一步特等，这一卦也不丢人。`,
  ],
  中等马: [
    (name) => `军师点名的${name}本局中等马，这一卦算是平平无奇。`,
    (name) => `军师点名的${name}本局中等马，不好不坏，军师这一卦只能算勉强。`,
    (name) => `军师点名的${name}本局中等马，军师的卦象有点含糊。`,
  ],
  下等马: [
    (name) => `军师点名的${name}本局下等马，这一卦军师看走了眼。`,
    (name) => `军师点名的${name}本局下等马，军师认栽，下次卦要算准一点。`,
    (name) => `军师点名的${name}本局下等马，这一卦砸了，军师的锅。`,
  ],
  没有马: [
    (name) => `军师点名的${name}本局没有马，这一卦军师押错了，认罚。`,
    (name) => `军师点名的${name}本局没有马，军师这回是真的看走了眼。`,
    (name) => `军师点名的${name}本局没有马，军师回去重新算卦。`,
  ],
};

export interface PregameRecapInput {
  matchId: string;
  /** The name the report's own row shows for the pick; never the Riot ID. */
  name: string;
  /** The pick's tier in the finished match. */
  tier: HorseTier;
}

/**
 * Chinese text reads without spaces, so a name gets one only where it would touch the text with a letter or digit:
 * "小明" stays as it is, "Faker" becomes " Faker ", "小明2" becomes "小明2 ". One helper for every recap line.
 */
export function spacedName(name: string): string {
  const ascii = /[A-Za-z0-9]/;
  return `${ascii.test(name[0] ?? "") ? " " : ""}${name}${ascii.test(name.at(-1) ?? "") ? " " : ""}`;
}

/** One sentence naming the pick only. Deterministic per match, so the same match always shows the same line. */
export function buildPregameRecap({ matchId, name, tier }: PregameRecapInput): string {
  const choose = seededChooser(`recap:${matchId}`);
  return choose(RECAP_PHRASES[tier])(spacedName(readableName(name)));
}
