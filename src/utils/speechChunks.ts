/** Every speech request and every announcement stays within the local model's input limit. */
export const MAX_SPEECH_CHARACTERS = 1_000;
/** Short sentences are joined with the next one so a chunk covers the following chunk's generation. */
export const MIN_CHUNK_CHARACTERS = 10;
/**
 * Long sentences are split at clause marks so one chunk never delays playback for long.
 * A chunk exceeds this only by a joined fragment shorter than the minimum or by one unbreakable word or number.
 */
export const MAX_CHUNK_CHARACTERS = 80;

// A sentence ends at Chinese end marks, line breaks or an ellipsis, followed by any closing quotes or brackets
// and the whitespace after them. ASCII "!?;" end a sentence only before whitespace or the end of the text,
// so names such as "Faker!Fan" stay whole, and ASCII "." never does, so scores such as 9.9 stay intact.
const SENTENCE = /[^。！？；…\n]*?(?:[。！？；\n]|…+|[!?;](?=\s|$))+[”’」』）)"']*\s*/gu;
// Clause marks follow the same rule, so "1,000" is never split at its comma.
const CLAUSE = /[^，、：]*?(?:[，、：]|[,:](?=\s|$))+\s*/gu;

/** Consecutive pieces matched by the pattern, plus any unmatched rest, with their separators kept. */
function pieces(text: string, pattern: RegExp): string[] {
  const found = text.match(pattern) ?? [];
  const rest = text.slice(found.join("").length);
  return [...found, ...(rest ? [rest] : [])];
}

const word = (character?: string) => character !== undefined && /[A-Za-z0-9]/.test(character);
const digit = (character?: string) => character !== undefined && /[0-9]/.test(character);

/** Whether cutting before index i would divide a Latin word or a number such as 9.9 or 1,000. */
function insideToken(characters: string[], i: number): boolean {
  const before = characters[i - 1];
  const after = characters[i];
  if (word(before) && word(after)) return true;
  if ((before === "." || before === ",") && digit(characters[i - 2]) && digit(after)) return true;
  return (after === "." || after === ",") && digit(before) && digit(characters[i + 1]);
}

/** The last cut at or before the limit that keeps words and numbers whole, or else the first one after it. */
function hardCut(characters: string[]): number {
  for (let i = MAX_CHUNK_CHARACTERS; i > 0; i--) if (!insideToken(characters, i)) return i;
  for (let i = MAX_CHUNK_CHARACTERS + 1; i < characters.length; i++) if (!insideToken(characters, i)) return i;
  return characters.length;
}

/** Splits a sentence longer than the chunk limit at clause marks, then at a hard cut. */
function bounded(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_CHARACTERS) return [sentence];
  const result: string[] = [];
  let current = "";
  for (const clause of pieces(sentence, CLAUSE)) {
    if (current && current.length + clause.length > MAX_CHUNK_CHARACTERS) {
      result.push(current);
      current = "";
    }
    current += clause;
    while (current.length > MAX_CHUNK_CHARACTERS) {
      // Work on code points so a surrogate pair is never divided.
      const characters = [...current];
      const at = hardCut(characters);
      result.push(characters.slice(0, at).join(""));
      current = characters.slice(at).join("");
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Splits Chinese speech into ordered, sentence-sized chunks that are generated and played one after another.
 * Joining the chunks reproduces the trimmed text exactly, separators included.
 */
export function splitSpeech(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) throw new Error("TTS text cannot be empty.");
  if (normalized.length > MAX_SPEECH_CHARACTERS) throw new Error(`TTS text must be at most ${MAX_SPEECH_CHARACTERS} characters.`);
  const chunks: string[] = [];
  let pending = "";
  // A fragment shorter than the minimum always joins its neighbour, even past the soft maximum.
  for (const sentence of pieces(normalized, SENTENCE).flatMap(bounded)) {
    pending += sentence;
    if (pending.length >= MIN_CHUNK_CHARACTERS) {
      chunks.push(pending);
      pending = "";
    }
  }
  if (pending) {
    // A short final sentence joins the previous chunk instead of becoming its own request.
    if (chunks.length > 0) chunks[chunks.length - 1] += pending;
    else chunks.push(pending);
  }
  return chunks;
}
