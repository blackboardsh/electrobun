# Electrobun Template QA

This package-free meta-template installs every other template from the latest
Electrobun beta catalog and opens them from one dashboard. Materialization,
explicit npm setup, and production builds are serialized so Zig, Go, Rust, Odin,
and other native setup cannot race; prepared apps then launch together.

```sh
hutch electrobun init template-qa --template=all --beta
cd template-qa
hutch run dev
```

The generated projects live under
`templates/<beta-version>-<catalog-revision>/`. Successful apps stay open
together. Use the dashboard to inspect output, stop a template, or relaunch it.
Closing Template QA or interrupting its `hutch run dev` process stops all child
process trees.
