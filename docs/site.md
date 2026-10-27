# User site

The player-facing documentation lives in `site/`, an Astro Starlight project with its own `package.json` and lockfile.
It is Simplified Chinese first and is published at https://madvisor.rystudio.app.
The root `tsconfig.json` includes only `src`, so `npm run check` never sees `site/`.

## Run it locally

```sh
npm --prefix site ci
npm --prefix site run dev     # http://localhost:4321
npm --prefix site run build   # writes site/dist, must finish without warnings
```

Node 22.12 or newer is required, the same as the bot.
`astro` and `@astrojs/starlight` are pinned to exact versions that were at least two weeks old when chosen.

## Deploy

`.github/workflows/docs.yml` builds `site/` with Node 22 and publishes `site/dist` to GitHub Pages.
It runs on a push to `main` that touches `site/**` or the workflow, and on manual dispatch.
The site is served from the domain root, so `astro.config.mjs` sets `site` and no `base`.
`site/public/CNAME` documents the custom domain.
The repository's Pages source must be set to GitHub Actions and the DNS CNAME must point at the Pages host; both are done by hand in the settings, not by the workflow.

## Content rules

Pages describe only what is merged on `main`; ideas in [Backlog](backlog.md) are never presented as features.
Command names, options and permissions come from `src/commands`, not from the README.
Numbers such as the 10-account limit or the 90 second window must match the owning document or the code.
When a feature changes, update its page in the same change:

| Page | Source of truth |
| --- | --- |
| 终局播报, 车队内战 | [Announcements](announcements.md), [Horse ranking](scoring.md) |
| 军师赛前锦囊与锦囊回顾 | [Announcements](announcements.md#game-start), [马厩](stable.md#军师赛前锦囊) |
| 马厩 | [马厩](stable.md) |
| /why 判决书与上诉 | [/why 判决书](why.md) |
| 马报 | [马报](ma-bao.md) |
| 评分规则 | [Horse ranking](scoring.md) |
| 命令一览 | `src/commands` |

Write Markdown with one full sentence per line and no em dash.
The footer carries Riot's legal notice; the site uses no Riot logos or game art.

## Adding English

Add `en: { label: "English", lang: "en" }` to `locales` in `site/astro.config.mjs` and put the translated pages in `site/src/content/docs/en/`.
UI string overrides for a language go in `site/src/content/i18n/<lang>.json`.
