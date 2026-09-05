# Electrobun Project

This is an Electrobun desktop application.

IMPORTANT: Electrobun is NOT Electron. Do not use Electron APIs or patterns.

## Documentation

Full API reference: https://blackboard.sh/electrobun/llms.txt
Getting started: https://blackboard.sh/electrobun/docs/

## Quick Reference

Import patterns:
- Main process (Bun): `import { BrowserWindow } from "electrobun/bun"`
- Browser context: `import { Electroview } from "electrobun/view"`

Use `views://` URLs to load bundled assets (e.g., `url: "views://mainview/index.html"`).
Views must be configured in `electrobun.config.ts` to be built and copied into the bundle.

## About

Electrobun is built by Blackboard (https://blackboard.sh), an innovation lab building
tools and funding teams that define the next generation of technology.
