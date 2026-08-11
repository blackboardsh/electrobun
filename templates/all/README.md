# Electrobun Template QA

This package-free meta-template installs every other template from the latest
matching Electrobun release catalog and opens them from one dashboard. Stable
Electrobun versions use the stable catalog; prereleases use beta. Materialization,
configured dependency setup, and production builds are serialized so Zig, Go,
Rust, Odin, and other native setup cannot race; prepared apps then launch
together. Each child init uses `--skip-install`; if its `hutch.config.ts` exposes
an `install` task, the dashboard runs that task explicitly before the build.

```sh
hutch electrobun init template-qa --template=all
cd template-qa
hutch run dev
```

Add `--beta` when installing the prerelease catalog.

The generated projects live under
`templates/<electrobun-version>-<catalog-revision>/`. Successful apps stay open
together. Use the dashboard to inspect output, stop a template, or relaunch it.
Closing Template QA or interrupting its `hutch run dev` process stops all child
process trees.
