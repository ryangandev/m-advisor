# /why 判决书 and 上诉

`/why [user] [match]` explains one stored horse verdict: a radar of the nine dimensions against the member's position, what cost them the most, how far the neighbouring tiers were, and what the 军师 said.
An 上诉 button lets the member appeal, and the 军师 always upholds the verdict with data.
Everything is read from the 马厩 records described in [马厩](stable.md); no match is fetched from Riot again and no record is ever changed.

## Choosing the record

`user` defaults to the caller and `match` to their latest record of the kind the bot runs on, real or mock.
The `match` option autocompletes the member's 25 latest records, newest first, as `tier · champion · score · result · Pacific date`, with a 模拟 prefix in mock mode.
Typing filters the list, and a bare number such as `5123456789` is read as `NA1_5123456789`.
`findVerdictRecord` and `listVerdictChoices` in `src/services/horseVerdict.ts` do the selection.

Only bound members have records, so a stranger gets a private empty state that explains binding, and nobody else in the match ever appears.
The empty state is also private when the member has no records yet or the chosen match is not theirs, and it says when the other data mode holds games.
A record found is answered in public: the reply is deferred, then edited with the embed, the attached `why-verdict.png` and the 上诉 button.

## The verdict

`buildVerdict(record)` in `src/services/horseVerdict.ts` is pure.

- Every dimension's impact is its position weight times its distance from the median, `weight × (percentile - 0.5)`, the same weights that combine the score (see [Horse ranking](scoring.md#model)).
- The up to three most negative impacts are 拖后腿的维度, costliest first; a dimension with no weight for the position, such as frontline for a bottom laner, never counts.
- The most positive impact is the 亮点.
- Each named dimension quotes one or two of the record's own statistics, such as 每分钟视野得分 0.8 or 参团率 24%.
- `score_above` and `score_below` give the gap to the teammate ranked one place higher and lower, and `tierForRank` names their tier.
- A gap of at most `CLOSE_GAP` = 0.3 points is 惜败 (just missed the tier above) or 险胜 (just held off the tier below).
  0.3 points is 3 percentile points of same-position players, well under the usual gap between neighbouring teammates.
  Gaps print with the announcement's rounding, and a gap that rounds to 0.0 prints as 不到 0.1.

The embed shows the member, champion, position, result and time, the tier and score, the 拖后腿的维度 with the 亮点, the gaps, the praise or roast stored from the announcement when there was one, and a one-line 军师判词.
The 判词 says 你 only when the caller is the member and names the member otherwise.
Records with no position use the all-position weights and show 未知位置.

## The radar image

`src/utils/whyRadar.ts` draws the radar as SVG and rasterizes it to an 800 × 940 PNG with `@resvg/resvg-js`.

- Nine axes carry the Chinese dimension names and the member's percentiles, green at or above the median and red below.
- The dashed ring is the 50th percentile of the same position.
- The two or three dimensions whose position weight is at least `KEY_WEIGHT` = 0.14 are the position's key dimensions: their axes are brighter and their labels bold with a ★.
- A dimension the match had no data for sits at the centre and reads 无数据 rather than 0%.
- The title shows the tier in its color, the score, the champion, the position, the result and the team rank.
- A mock record carries a 模拟数据 badge and legend note.
- The image names nobody: no Discord or Riot name appears in it.

The card brings its own dark background with rounded corners, so it reads the same in Discord's light and dark themes; the tier colors were chosen for that background.

### Why resvg-js

`@resvg/resvg-js` 2.6.2 is pinned exactly.
It ships prebuilt binaries for Apple Silicon, Intel macOS, Linux and Windows as optional packages, so it needs no system library, no compiler and no install script.
The alternatives need more: `canvas` builds on Cairo and falls back to compiling it where no prebuilt binary fits, `sharp` brings a whole image-processing library for one rasterization, and a headless browser is far too heavy for one image.
Drawing SVG in code keeps the chart a plain string, which the tests compare with a reviewed snapshot.
It renders on a worker thread through `renderAsync`, in about 0.2 seconds.

### Fonts

No font is bundled.
The renderer loads only known system CJK font files that exist, found once per process: PingFang (older macOS), Hiragino Sans GB and STHeiti on macOS, Noto Sans CJK and WenQuanYi on Linux, and Microsoft YaHei on Windows.
The SVG asks for PingFang SC first, then Hiragino Sans GB, Heiti SC, Noto Sans CJK SC, Source Han Sans SC, Microsoft YaHei and WenQuanYi Micro Hei.
Current macOS keeps PingFang outside the font folders resvg can read, so this Mac draws with Hiragino Sans GB.
When none of the known files exists, the renderer logs a warning and scans every system font instead, which is slower but finds any installed CJK font.

## 上诉

The button's custom ID is `why-appeal:<r|m>:<member>:<match>`, so the handler knows which record to read without storing anything.
`src/events/interactionCreate.ts` routes a button to the command whose `componentPrefix` matches, and routes autocomplete to the command's `autocomplete`.

- Only the member the verdict is about can appeal; anyone else gets a private, playful refusal.
- The ruling is public, rereads the record, and is always 驳回上诉，维持原判.
- It cites the costliest dimension with its percentile, its share of the position's score and its statistics; a 特等马 is told there is nothing higher, and a verdict with nothing below the median cites the gap instead.
- It admits 惜败 or 险胜 under the same `CLOSE_GAP`.
- After the ruling the button turns into a disabled 本案已结 · 维持原判.
- One member appeals one match once: a repeat appeal, even from another `/why` message, gets a private 本案已结，维持原判。
  Closed cases are kept in memory only, at most 5000, so nothing new is written to the database.
  After a restart a repeat appeal is heard again and, being deterministic, gets the same ruling.
- A mock verdict's appeal reads only mock records and carries the mock title and footer.

## Wording

Every phrase is picked deterministically: the verdict by match and member, the ruling by match and appellant, and a refusal by match and the person who clicked.
Lines talk about play only, never identity, appearance or family.
Every reply uses `allowedMentions` with nothing allowed, so a quoted member is shown but never pinged.

## Verification

`tests/horseVerdict.test.ts` covers the impact ordering, key dimensions, missing dimensions, neighbouring tiers and the 惜败 threshold, evidence, the summary and the ruling wording, and record selection.
`tests/whyRadar.test.ts` compares the SVG with `tests/snapshots/why-radar-support.svg`, checks labels, the mock badge and escaping, renders PNGs of the expected size and checks that Chinese labels draw ink on macOS.
After reviewing an intended change to the image, run it with `UPDATE_SNAPSHOTS=1` to refresh the snapshot.
It writes review images of a 没有马 support, a 特等马 jungler and a mock record to the ignored `test-results/why/`.
`tests/why.test.ts` covers the command, the empty states, mock labeling, autocomplete, the appeal permission, the closed case and that the record is unchanged.
`tests/interaction-handler.test.ts` covers button and autocomplete routing.
