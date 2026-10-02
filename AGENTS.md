# M-Advisor

A local, on-demand Discord bot for NA League of Legends profiles and Chinese game-end voice announcements.
Start with [docs/README.md](docs/README.md) and read only the relevant subsystem.

- Use Node.js 22.12 or newer; this checkout is verified with Node 24.
- Run `npm run check` before committing and keep each feature in its own commit.
- Never log tokens, commit `.env`, database files, generated audio, or model weights.
- Mock data must be visibly labeled and must never replace a failed real API request silently.
- Reuse the installed Media voice runtime and model cache; do not modify that shared workspace.
- Real Discord channel tests require an identified, user-authorized target.
- Compilation, mock tests, Discord playback, human listening, and real Riot acceptance are separate evidence.

See [runtime](docs/runtime.md) and [current status](docs/status.md).
