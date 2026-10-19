import { writeFileSync } from "node:fs";

writeFileSync("install-result.json", JSON.stringify({ token: process.env.ELECTROBUN_ACCEPTANCE_TOKEN, execPath: process.execPath }));
