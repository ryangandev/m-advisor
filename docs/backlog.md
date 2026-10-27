# Feature backlog

Ideas that came out of the 2026-10-26 product review and were deliberately left for later.
The features chosen for the current delivery are tracked in [Status](status.md), not here.
Move an item out of this list when work on it starts.

## Parity with other League bots

### Rank and LP changes

Show the LP gained or lost and the current tier in each ranked report, and announce promotions and demotions separately.
Take a league-v4 snapshot of the tracked account before and after each ranked game; match-v5 does not report LP.
Dorans-bot and LP tracker already offer this, so it is expected by players who use those bots.

### More queues and regions

ARAM needs its own reference sample and position-free weights, because lanes and roles do not apply.
Arena and other rotating modes need their own scoring or should stay unannounced.
Other regions need regional routing for account-v1, league-v4 and match-v5, and a region choice in `/bind` and `/profile`.

### Always-on hosting

The bot runs on demand on Ryan's Mac, so it misses games and scheduled reports while the Mac is off.
Hosting needs either an Apple Silicon machine for the local Qwen speech model or a separate speech host.
A permanent personal or production Riot API key is needed before the bot runs unattended, because development keys expire every 24 hours.

## Distinctive features

### Optional LLM commentary

A local language model could rewrite the template commentary into more varied lines.
It must quote only statistics the ranking already computed, and the deterministic templates stay as the fallback.
The README currently places LLM commentary outside the delivery, so this needs Ryan's approval before work starts.

### Custom announcer personas

Qwen3-TTS VoiceDesign can create new voices from a written description, such as a Hong Kong esports caster or a Northeastern Chinese storyteller.
Each persona needs its own style instructions and a human listening check.
Cloning a real person's voice is out of scope.
