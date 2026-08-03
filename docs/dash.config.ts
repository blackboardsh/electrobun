// @dash cli=0.5.0-canary.8 cottontail=0.2.3
export default {
  scripts: {
    dev: "astro dev",
    start: "astro dev",
    build: "astro build",
    preview: "astro preview",
    check: "astro check && node scripts/check-code-examples.mjs",
    "check:examples": "node scripts/check-code-examples.mjs",
    clean: "rm -rf dist .astro",
    deploy:
      'wrangler pages deploy dist --project-name=framework-docs --branch="$PAGES_BRANCH"',
  },
};
