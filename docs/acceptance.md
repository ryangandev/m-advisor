# End-to-end acceptance

The workflow is a bound account, a completed match, Chinese speech generation, Discord voice playback and cleanup.
Automated checks, real local model execution, Discord transport and human listening are separate acceptance steps.
The current result and remaining user blockers live in [Status](status.md).

## Reproducible automated checks

```sh
npm ci
npm run check
npm run doctor
```

The behavioral tests exercise Riot response parsing and errors, persistence across processes, baseline handling, tracked-account results, retries, duplicate prevention, voice queue cancellation, command permissions and shutdown races.
External Discord, Riot and speech boundaries are stubbed in the deterministic test suite.
The doctor executes the installed FFmpeg binary, opens SQLite in memory and reports codec/encryption dependencies.
Configuration flags show presence only; they do not validate credentials.

## Real offline speech and codec check

```sh
npm run verify:local
```

This verifier forces mock data and local speech, creates an isolated temporary database and uses a simulated Discord channel.
It binds `MockLoss#NA1`, establishes a silent baseline, creates a loss and runs the actual match-monitor and shared announcement queue.
The installed Qwen model generates the full Chinese commentary.
The installed FFmpeg binary converts it to 48 kHz stereo Opus.
A subsequent poll must not speak again.
The verifier then shuts down the worker, closes SQLite and removes its temporary data.

The ignored `test-results/local-e2e.json` records the result and timings.
`test-results/local-e2e.wav` preserves the generated audio for listening.
On 2026-10-02 this workflow passed with a 210,928-byte Opus output, 19.13 seconds of speech generation and 19.58 seconds total execution.
These timings are observations on this Mac and depend on model startup, available memory and workload.
This check does not establish a Discord connection or prove that another participant heard the audio.

## Actual startup check

The compiled bot was also exercised against the real Discord Gateway with an isolated empty database.
Login, local model prewarming and SIGTERM cleanup passed with exit code 0.
The ignored `test-results/gateway-lifecycle.json` records this observation.
That run did not register commands, send messages or join a voice channel.
It validates the actual startup path without substituting for live audio acceptance.

A subsequent read-only REST preflight confirmed access to the proposed server and General voice channel.
The bot's effective channel permissions include View Channel, Connect, Speak and Send Messages.
This result removes a permissions concern but does not prove voice transport or audible playback.
The ignored `test-results/discord-preflight.json` records the inventory without credentials.
At that check the server had no guild commands and the application retained older global command definitions, including `/testvc`.

## Live observations

Ryan authorized Ry的四合院 / General on 2026-10-02 and opened Discord for testing.
The actual desktop client connected to General with its microphone muted and deafen off.
The bot logged in and prewarmed the installed local speech model.
Both the default Serena test and an Uncle_Fu test after `/announcer style:Old Man` returned the actual `/testvoice` completion reply.
The bot left the voice channel after each playback.
Human listening confirmation is still required.

The Discord command picker also exposed older global definitions alongside guild replacements.
The explicit single-server migration removed six known legacy global definitions after verifying the bot belonged only to the authorized server and all replacement commands were present.
`test-results/command-migration.json` records the fresh REST inventory: zero globals and seven guild commands.
The ignored `test-results/legacy-global-commands.json` preserves their earlier definitions for recovery.
No other applications or servers were changed.

After the Mac was unlocked, reloading Discord cleared the retired definitions from the command picker.
The actual `/profile riotid:MockWin#NA1` displayed the simulated-data title and footer.
The actual `/bind` and `/bindings` commands confirmed the intended member and visibly identified the saved mock account.
Both native `/simulate` outcomes returned their completion confirmations, and the General chat displayed the corresponding mock win and loss reports.

## Repeatable actual Discord transport check

Stop the normal bot first and have the authorized test member join the configured General channel.
The verifier defaults to the server owner; set `TEST_MEMBER_ID` locally only when using another authorized member.

```sh
npm run verify:discord -- --confirm-live
```

The explicit flag is required because this check connects to Discord, joins voice and posts two visibly simulated reports.
It forces mock Riot data and local Qwen speech within its own process, and uses an isolated temporary SQLite database.
It establishes a silent historical baseline, announces a win with Serena and a loss with Uncle_Fu, and checks the exact completed match IDs.
The next poll must remain silent after each outcome.
Actual Gateway voice-state events must show two joins and two leaves, and real Discord message retrieval must return both correctly labeled reports.
Cleanup stops polling, destroys the client, closes the speech worker and database, and removes the temporary data.
The normal bot's saved binding and voice preference remain unchanged.

On 2026-10-02 this run passed in 95.279 seconds with two joins, two leaves, two actual report messages and no remaining voice connections.
The ignored `test-results/discord-e2e.json` records the evidence without credentials.
The verifier invokes the production monitor directly; native slash-command acceptance is a separate observation.
Human listening is still pending confirmation, even after successful transport.

## Live Discord test

First confirm the server and ordinary voice channel that may be used for testing.
Set their IDs locally as `TEST_GUILD_ID` and `TEST_VOICE_CHANNEL_ID`.
Set `RIOT_MODE=mock` and `TTS_PROVIDER=local` for this procedure.
The offline verifier sets these only in its own process and never changes `.env`.
The authorized target for this session is `Ry的四合院` / `General`.

```sh
npm run build
npm run register
npm start
```

Registration is a deliberate guild-scoped operation; startup does not register commands.
Wait for `Speech provider ready.` in the terminal.
A server administrator should join the configured channel and run these commands in Discord:

1. `/profile riotid:MockWin#NA1` and confirm the visible simulated-data label.
2. `/bind user:@yourself riotid:MockWin#NA1` and inspect `/bindings`.
3. `/announcer style:Sweet Girl`, then `/testvoice`.
4. Confirm the bot joins, speaks audibly and leaves; repeat with `Old Man`.
5. `/simulate outcome:胜利`, then `/simulate outcome:失败`.
6. Confirm both outcomes and mock labels are correct, no old game is replayed and no duplicate announcement appears on the next poll.
7. Stop with Ctrl+C, launch again and confirm `/bindings` and the chosen voice persist.
8. Leave voice, move out of the permitted test channel or `/unbind`, and confirm stale work does not play there.

Use an account binding intended for the test, since `/bind` and `/unbind` deliberately update persistent local data.
The test commands reject non-administrators, other servers and mismatched configured voice channels.
Moving away during generation or playback cancels the announcement.
`/testvoice` reporting completion validates the playback lifecycle; a listener must still confirm audible sound and acceptable pronunciation/volume.

If command registration, Gateway login or voice connection reports a permission error, record the exact operation and required permission before asking Ryan to change the server or Developer Portal.
Do not classify a hypothetical permission issue as a blocker.

## Real Riot acceptance

Mock mode permits all preceding engineering and voice work without a Riot key.
For real match data, put a valid key into local `.env`, set `RIOT_MODE=real` and restart.
The credential found during the initial audit returned HTTP 401.
Never put the replacement key in chat, source history or diagnostic output.

Run `/profile` with a real NA Riot ID, then bind the intended member using that Riot ID.
If that member differs from the existing tracked member, first `/unbind` the existing member.
Rebinding the same ID replaces a saved simulated account; other simulated bindings remain visibly identified and are skipped in real monitoring.
Enter voice before completing a new supported match and confirm its actual result is announced once.
An expired key or rate-limit error must stay an explicit real-provider error, with no automatic mock substitution.
`/simulate` must reject real mode.

Cloud speech credentials, an LLM API and speech recognition are not prerequisites for this workflow.
