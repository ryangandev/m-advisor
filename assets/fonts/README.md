# Radar font

`NotoSansSC-Regular.subset.otf` and `NotoSansSC-Bold.subset.otf` are subsets of Noto Sans SC, bundled so the `/why` radar draws the same Chinese labels on any host.
They are licensed under the SIL Open Font License 1.1, whose text is in `LICENSE` in this directory.
The renderer in `src/utils/whyRadar.ts` loads them first and keeps the system CJK fonts as a fallback for glyphs outside the subset.

## Source

- Font: Noto Sans SC 2.004, `NotoSansSC-Regular.otf` and `NotoSansSC-Bold.otf` from `18_NotoSansSC.zip`.
- Download: `https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/18_NotoSansSC.zip` (release `Sans2.004`).
- SHA-256 of the zip: `4d107c09ada479d3e48b6e78c83835773cbd9214bf6e12cdb7b60f8e068292ec`.
- Character list: the 3500 characters of the 一级字表 of the 通用规范汉字表 (2013), read from the `kTGH` field of the Unicode 18.0.0 Unihan database (`Unihan_OtherMappings.txt`, entries 1 to 3500) and stored in `scripts/data/tgh-level-1.txt`.

## What the subset keeps

- The 3500 characters of the 一级字表, for Chinese champion names added in later patches.
- Every character of the Chinese champion names in `src/data/championNamesZh.json`, the dimension names, tier names, position labels and the fixed strings the radar draws.
- Printable ASCII, fullwidth ASCII forms and the punctuation and signs the radar uses, including the star.

It drops hinting and every layout feature, which short horizontal labels do not need.
The result is plain OpenType (CFF), the format resvg reads, with the family name `Noto Sans SC`.
`tests/whyRadar.test.ts` reads the files' character tables and fails when the radar can draw a character the subset lacks.

## Regenerating

Download and unzip the font (the script itself never touches the network), install fonttools, then run the script from the repository root:

```sh
python3 -m venv /tmp/fonttools-venv && /tmp/fonttools-venv/bin/pip install fonttools
node --import tsx scripts/subset-radar-font.ts \
  --regular /path/to/NotoSansSC-Regular.otf --bold /path/to/NotoSansSC-Bold.otf \
  --pyftsubset /tmp/fonttools-venv/bin/pyftsubset
```

Use `--out <directory>` to write somewhere other than `assets/fonts`.
Regenerate after `npm run champions:update` adds champions or after the radar gains new fixed text.
