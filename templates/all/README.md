# Electrobun Template QA

This package-free meta-template installs every other template from the latest
matching Electrobun release catalog and opens them from one dashboard. Stable
Electrobun versions use the stable catalog; prereleases use beta. Materialization,
configured dependency setup, and native tool preparation are serialized. The
prepared apps then run `hutch run start` together, so their dev builds can
overlap. Each child init uses `--skip-install`; if its `hutch.config.ts` exposes
an `install` task, the dashboard runs that task explicitly before launch.

Like every published template, this project has no source-level Electrobun pin.
Hutch records the catalog release in `.hutch/devkit` during initialization, and
the dashboard uses that projection as its exact release identity. If the mutable
channel catalog has advanced since then, reinstall the QA template in a new
directory, adding `--beta` again for the beta catalog, before relaunching it. A
plain sync can follow the launcher's channel instead of the channel originally
selected for this floating template.

```sh
hutch electrobun init template-qa --template=all
cd template-qa
hutch run dev
```

Add `--beta` when installing the prerelease catalog.

The generated projects live under `templates/<template-id>/`. Successful apps
stay open together. Use the dashboard to inspect output, stop a template, or
relaunch it.
Closing Template QA or interrupting its `hutch run dev` process stops all child
process trees.
