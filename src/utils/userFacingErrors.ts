function getErrorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim() ? error.message.trim() : null;
}

function getStatusCode(message: string): number | null {
  const match = message.match(/\b([1-5]\d{2})\b/);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

export function getRiotUserErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (!message) {
    return "Unable to complete the Riot lookup right now.";
  }

  const statusCode = getStatusCode(message);
  if (statusCode === 400 || statusCode === 404) {
    return "No Riot account was found for that Riot ID.";
  }
  if (statusCode === 401 || statusCode === 403 || message.includes("RIOT_API_KEY")) {
    return "The Riot API request was rejected. The bot configuration needs attention.";
  }
  if (statusCode === 429) {
    return "The Riot API is rate-limiting requests. Please try again shortly.";
  }
  if (statusCode !== null && statusCode >= 500) {
    return "The Riot API is unavailable right now. Please try again later.";
  }
  if (message.startsWith("Missing ")) {
    return "The Riot API is not configured correctly.";
  }

  return "Unable to complete the Riot lookup right now.";
}

export function getTtsUserErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (!message) {
    return "Unable to generate speech right now.";
  }

  if (message.includes("authentication failed")) {
    return "TTS authentication failed. The bot configuration needs attention.";
  }
  if (message.includes("region is invalid")) {
    return "The configured Azure TTS region is invalid or unavailable.";
  }
  if (message.includes("rate limit")) {
    return "The TTS service is rate-limiting requests. Please try again shortly.";
  }
  if (message.includes("could not be reached")) {
    return "The TTS service could not be reached. Please try again later.";
  }
  if (message.includes("empty audio")) {
    return "The TTS service returned empty audio.";
  }
  if (message.includes("not configured")) {
    return "TTS is not configured correctly.";
  }
  if (message.includes("text cannot be empty")) {
    return "TTS text cannot be empty.";
  }

  return "Unable to generate speech right now.";
}

export function getCommandUserErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (!message) {
    return "Something went wrong while handling that command.";
  }

  if (message.includes("TTS")) {
    return getTtsUserErrorMessage(error);
  }
  if (message.includes("Riot")) {
    return getRiotUserErrorMessage(error);
  }

  return "Something went wrong while handling that command.";
}
