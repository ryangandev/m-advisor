// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { joinCjkLines } from "./plugins/join-cjk-lines.mjs";

// The custom domain is served from the root, so there is deliberately no `base`.
export default defineConfig({
  site: "https://madvisor.rystudio.app",
  // Astro's default Markdown processor, plus a plugin that joins source lines between Chinese sentences.
  // .mdx pages inherit this processor.
  markdown: { processor: satteri({ mdastPlugins: [joinCjkLines] }) },
  integrations: [
    starlight({
      title: "策马军师",
      description: "M-Advisor 策马军师：Discord 里的 LoL 终局中文语音播报，把队友排成特等马到没有马。",
      logo: { src: "./src/assets/logo.svg", alt: "策马军师" },
      favicon: "/favicon.svg",
      // Chinese first. To add English later: add `en: { label: "English", lang: "en" }` below
      // and put the translated pages in `src/content/docs/en/`.
      defaultLocale: "root",
      locales: {
        root: { label: "简体中文", lang: "zh-CN" },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/ryangandev/m-advisor" }],
      customCss: ["./src/styles/custom.css"],
      components: {
        Footer: "./src/components/Footer.astro",
      },
      // Pagefind search is Starlight's default; it is stated here so nobody switches it off by accident.
      pagefind: true,
      sidebar: [
        {
          label: "开始",
          items: [{ slug: "quick-start" }, { slug: "faq" }],
        },
        {
          label: "功能",
          items: [
            { slug: "features/game-end" },
            { slug: "features/pregame" },
            { slug: "features/party" },
            { slug: "features/stable" },
            { slug: "features/why" },
            { slug: "features/ma-bao" },
          ],
        },
        {
          label: "参考",
          items: [{ slug: "commands" }, { slug: "scoring" }, { slug: "privacy" }],
        },
      ],
    }),
  ],
});
