// @hutch cli=0.5.1 cottontail=0.3.0
export default {
  scripts: {
    install: ["npm", "ci"],
    dev: "npm exec -- astro dev",
    start: "npm exec -- astro dev",
    build: "npm exec -- astro build",
    preview: "npm exec -- astro preview",
    check: "npm exec -- astro check && node scripts/check-code-examples.mjs",
    "check:examples": "node scripts/check-code-examples.mjs",
    "test:project-boundary": [
      "node",
      "--test",
      "scripts/project-boundary.test.mjs",
    ],
    clean: "rm -rf dist .astro",
    deploy:
      'npm exec -- wrangler pages deploy dist --project-name=framework-docs --branch="$PAGES_BRANCH"',
  },
};
