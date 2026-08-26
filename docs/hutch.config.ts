// @hutch cli=0.26.0-canary.6 cottontail=0.6.0-canary.11
export default {
  packageManager: "npm",
  scripts: {
    install: ["hutch", "pm", "ci"],
    dev: "hutch pm exec -- astro dev",
    start: "hutch pm exec -- astro dev",
    build: "hutch pm exec -- astro build",
    preview: "hutch pm exec -- astro preview",
    check: "hutch pm exec -- astro check && node scripts/check-code-examples.mjs",
    "check:examples": "node scripts/check-code-examples.mjs",
    "test:project-boundary": [
      "node",
      "--test",
      "scripts/project-boundary.test.mjs",
    ],
    clean: "rm -rf dist .astro",
    deploy:
      'hutch pm exec -- wrangler pages deploy dist --project-name=framework-docs --branch="$PAGES_BRANCH"',
  },
};
