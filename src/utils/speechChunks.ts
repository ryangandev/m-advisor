/** Every speech request and every announcement stays within the local model's input limit. */
export const MAX_SPEECH_CHARACTERS = 1_000;
/** Short sentences are joined with the next one so a chunk covers the following chunk's generation. */
export const MIN_CHUNK_CHARACTERS = 10;
/** Long sentences are split at clause marks so one chunk never delays playback for long. */
export const MAX_CHUNK_CHARACTERS = 80;

// Sentence ends, followed by any closing quotes or brackets. ASCII "." is excluded because scores such as 9.9 use it.
const SENTENCE = /[^。！？；!?;…\n]*(?:[。！？；!?;\n]|…+)+[”’」』）)"']*/gu;
const CLAUSE = /[^，、：,:]*[，、：,:]+/gu;

function pieces(text: string, pattern: RegExp): string[] {
  const found = text.match(pattern) ?? [];
  const rest = text.slice(found.join("").length);
  return [...found, ...(rest ? [rest] : [])].map((piece) => piece.trim()).filter(Boolean);
}

/** Splits a sentence longer than the chunk limit at clause marks, then at the hard limit. */
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
      // Do not divide a surrogate pair when a single clause has no usable mark.
      const characters = [...current];
      result.push(characters.slice(0, MAX_CHUNK_CHARACTERS).join(""));
      current = characters.slice(MAX_CHUNK_CHARACTERS).join("");
    }
  }
  if (current) result.push(current);
  return result;
}

/**
 * Splits Chinese speech into ordered, sentence-sized chunks that are generated and played one after another.
 * Joining the chunks reproduces the text apart from whitespace around chunk boundaries.
 */
export function splitSpeech(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) throw new Error("TTS text cannot be empty.");
  if (normalized.length > MAX_SPEECH_CHARACTERS) throw new Error(`TTS text must be at most ${MAX_SPEECH_CHARACTERS} characters.`);
  const chunks: string[] = [];
  let pending = "";
  for (const sentence of pieces(normalized, SENTENCE).flatMap(bounded)) {
    if (pending && pending.length + sentence.length > MAX_CHUNK_CHARACTERS) {
      chunks.push(pending);
      pending = "";
    }
    pending += sentence;
    if (pending.length >= MIN_CHUNK_CHARACTERS) {
      chunks.push(pending);
      pending = "";
    }
  }
  if (pending) {
    // A short final sentence joins the previous chunk instead of becoming its own request.
    const last = chunks.at(-1);
    if (last && last.length + pending.length <= MAX_CHUNK_CHARACTERS) chunks[chunks.length - 1] = last + pending;
    else chunks.push(pending);
  }
  return chunks;
}
