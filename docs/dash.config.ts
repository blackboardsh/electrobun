// @dash cli=0.2.1 cottontail=0.1.1
export default {
  scripts: {
    dev: "astro dev",
    start: "astro dev",
    build: "astro build",
    preview: "astro preview",
    check: "astro check",
    clean: "rm -rf dist .astro",
    deploy:
      'wrangler pages deploy dist --project-name=framework-docs --branch="$PAGES_BRANCH"',
  },
};
