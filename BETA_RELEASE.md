# Electrobun release channels

Electrobun product releases and the npm bootstrap have independent versions
and independent publishing workflows.

## Electrobun product releases

Product tags use `v<version>`, for example `v2.1.0-beta.3`. They publish the
platform runtime, SDK/devkit artifacts, Kitchen builds, and the matching
stable or beta template catalog. They do not publish to npm.

An application's product version belongs in `electrobun.config.ts`. Selecting
an npm package version never selects an Electrobun runtime version.

## npm bootstrap releases

The npm package contains only the small `electrobun` command that installs and
invokes Hutch. Its semantic version changes only when that bootstrap contract
changes.

1. Update `npm/electrobun/package.json`.
2. Run its contract tests:

   ```sh
   cd npm/electrobun
   node --test test/bootstrap.test.mjs test/package.test.mjs
   npm pack --dry-run --ignore-scripts
   ```

3. Commit the change and create a matching `npm-v<version>` tag, such as
   `npm-v2.0.0`.
4. Push the tag. `.github/workflows/npm-bootstrap.yml` verifies the tag and
   publishes from `npm/electrobun` only.

A prerelease bootstrap version such as `2.0.1-beta.1` is published under npm's
`beta` dist-tag. That dist-tag still does not select beta Electrobun templates:

```sh
npx electrobun init          # stable templates
npx electrobun init --beta   # beta templates
```
