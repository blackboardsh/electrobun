import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Electrobun",
  tagline:
    "Build ultra fast, tiny, and cross-platform desktop apps with Typescript",
  favicon: "img/electrobun-logo-32.png",

  // Set the production url of your site here
  url: "https://electrobun.dev",
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: "/",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ["rss", "atom"],
            xslt: true,
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    announcementBar: {
      id: "alpha",
      content:
        "Electrobun is just getting started. The API is likely to change as we build toward a stable v1",
      backgroundColor: "#1160af",
      textColor: "#efefef",
      isCloseable: true,
    },
    // Replace with your project's social card
    // image: "img/social-card.jpg",
    navbar: {
      title: "Electrobun",
      logo: {
        alt: "Electrobun Logo",
        src: "img/electrobun-logo-256.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "guidesSidebar",
          position: "left",
          label: "Docs",
        },
        {
          type: "docSidebar",
          sidebarId: "apiSidebar",
          position: "left",
          label: "API Reference",
        },
        { to: "/blog", label: "Updates", position: "left" },
        {
          href: "https://github.com/blackboardsh/electrobun",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Getting Started",
              to: "/docs/guides/Getting%20Started/",
            },
            {
              label: "What is Electrobun?",
              to: "/docs/guides/Getting%20Started/What%20is%20Electrobun",
            },
            {
              label: "Hello World",
              to: "/docs/guides/Getting%20Started/Hello%20World",
            },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/blackboardsh/electrobun/issues",
            },
            {
              label: "Discord",
              href: "https://www.electrobun.dev/#",
            },
            {
              label: "Twitter",
              href: "https://x.com/BlackboardTech",
            },
            {
              label: "Blog",
              to: "/blog",
            },
          ],
        },
        {
          title: "Sponsors",
          items: [
            {
              label: "Blackboard Technologies Inc.",
              href: "https://blackboard.sh",
            },
          ],
        },
      ],
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["json", "typescript"],
      defaultLanguage: "typescript",
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
