# Electrobun Template QA

This package-free meta-template installs every other template from the latest
matching Electrobun release catalog and opens them from one dashboard. Stable
Electrobun versions use the stable catalog; prereleases use beta. Materialization,
configured dependency setup, and native tool preparation are serialized. The
prepared apps then run `hutch run start` together, so their dev builds can
overlap. Each child init uses `--skip-install`; if its `hutch.config.ts` exposes
an `install` task, the dashboard runs that task explicitly before launch.

The checked-in meta-template stays unpinned so repository development can run it
against a locally built Electrobun devkit. Template publication adds the shipped
Electrobun version to the staged archive's `hutch.config.ts`. In both modes the
dashboard uses `.hutch/devkit` as its exact release identity; when a config pin is
present, it must match that projection. Every child installed from the catalog
must both pin and project the catalog's exact version, or the dashboard rejects
or reinstalls it before launch.

If the mutable channel catalog has advanced since this QA project was prepared,
reinstall it in a new directory, adding `--beta` again for the beta catalog,
before relaunching it. A source checkout without a pin can follow the launcher's
channel when explicitly synced.

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
