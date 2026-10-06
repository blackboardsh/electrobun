import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ViteAlias = { find: RegExp; replacement: string };

// Returns Vite aliases for the `electrobun` package based on the `exports` field in package.json
export function electrobunAliases(root: string): ViteAlias[] {
    const pkg = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    return Object.entries(pkg.exports ?? {})
        .filter((entry): entry is [string, string] => {
            const target = entry[1];
            return typeof target === "string" && target.startsWith("./api/");
        })
        .map(([subpath, target]) => {
            const specifier =
                subpath === "."
                    ? "electrobun"
                    : `electrobun/${subpath.slice(2)}`;
            return {
                find: new RegExp(
                    `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                ),
                replacement: resolve(root, target),
            };
        });
}
