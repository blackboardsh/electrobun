"use strict";

// Electrobun 2.x application APIs are not distributed through npm. The SDK
// is projected into your project by Hutch; this module exists only to turn
// a stale import into instructions.

throw new Error(
	"Electrobun 2.x APIs come from the Hutch devkit, not node_modules. " +
		"Run `npx electrobun dev` (or `hutch electrobun sync`) so imports " +
		"resolve from .hutch/devkit, and see the migration guide: " +
		"https://electrobun.dev/electrobun/guides/migrating-to-v2",
);
