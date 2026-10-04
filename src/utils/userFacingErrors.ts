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
  let simulated = error instanceof RiotApiError && error.simulated;
  try { simulated ||= isMockData(); }
  catch { /* An invalid configuration must still produce a safe error reply. */ }
  const message = riotUserErrorMessage(error);
  return simulated ? `模拟数据: ${message}` : message;
}

function riotUserErrorMessage(error: unknown): string {
  if (error instanceof RiotApiError) {
    switch (error.code) {
      case "invalid_mode": return "The bot data mode needs attention. RIOT_MODE must be mock or real.";
      case "missing_key":
      case "unauthorized":
      case "forbidden": return "The Riot API request was rejected. The bot configuration needs attention.";
      case "not_found": return "No Riot account or match was found.";
      case "rate_limited": {
        const seconds = Math.ceil((error.retryAfterMs ?? 1000) / 1000);
        return `The Riot API is rate-limiting requests. Please try again in ${seconds} seconds.`;
      }
      case "unavailable": return "The Riot API is unavailable right now. Please try again later.";
      case "timeout": return "The Riot API request timed out. Please try again shortly.";
      case "network": return "Unable to reach the Riot API. Please try again shortly.";
      case "invalid_response": return "The Riot API returned an unexpected response. Please try again later.";
      case "mock_only": return "Simulated matches are only available when RIOT_MODE=mock.";
      case "bad_request": return "Unable to complete this Riot request. Check the Riot ID and bot configuration.";
    }
  }
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

  if (message.includes("queue is full")) {
    return "Speech is busy with other announcements. Please try again shortly.";
  }
  if (message.includes("timed out")) {
    return "Speech generation timed out. Please try again.";
  }
  if (message.includes("shut down")) {
    return "The bot is shutting down.";
  }
  if (message.includes("model or Python dependencies are unavailable")) {
    return "The local speech model is not configured correctly.";
  }
  if (message.includes("text cannot be empty")) {
    return "TTS text cannot be empty.";
  }

  return "Unable to generate speech right now.";
}

export function getCommandUserErrorMessage(error: unknown): string {
  if (error instanceof RiotApiError) return getRiotUserErrorMessage(error);
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
import { isMockData, RiotApiError } from "../services/riotData";
