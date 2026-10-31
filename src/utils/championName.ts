/**
 * Tidies the spaced middle dot in a Chinese champion name (烈娜塔 · 戈拉斯克 becomes 烈娜塔·戈拉斯克, like 奥瑞利安·索尔).
 * Every text row separates its parts with " · ", so a name that carried the same string would read as two parts.
 */
export function normalizeChampionName(name: string): string {
  return name.replace(/\s*·\s*/g, "·");
}
