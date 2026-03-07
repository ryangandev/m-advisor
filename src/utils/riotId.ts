const RIOT_ID_PATTERN = /^(?<gameName>[^#]{1,16})#(?<tagLine>[A-Za-z0-9]{2,10})$/u;

const INVALID_RIOT_ID_MESSAGE = "Invalid Riot ID format. Use GameName#TAG (example: Faker#KR1).";

interface ParsedRiotId {
  gameName: string;
  tagLine: string;
}

export function parseRiotId(value: string): ParsedRiotId | null {
  const trimmedValue = value.trim();
  const match = RIOT_ID_PATTERN.exec(trimmedValue);
  if (!match?.groups) {
    return null;
  }

  const gameName = match.groups.gameName.trim();
  const tagLine = match.groups.tagLine.trim();

  if (!gameName || !tagLine) {
    return null;
  }

  return { gameName, tagLine };
}

export { INVALID_RIOT_ID_MESSAGE };
