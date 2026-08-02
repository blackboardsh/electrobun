import { describe, expect, it } from "bun:test";
import { decodeDialogPaths } from "./dialog-paths";

describe("file-dialog path serialization", () => {
	it("round-trips commas and JSON-sensitive path characters", () => {
		const paths = [
			"/tmp/report,final.txt",
			"C:\\Users\\name\\quoted\"file.txt",
			"line\nbreak\tand\u0001-control",
			"/tmp/caf\u00e9.txt",
		];

		expect(decodeDialogPaths(JSON.stringify(paths))).toEqual(paths);
	});

	it("represents cancellation as an empty path list", () => {
		expect(decodeDialogPaths("[]")).toEqual([]);
		expect(decodeDialogPaths("")).toEqual([]);
	});

	it("rejects malformed or non-string payloads", () => {
		expect(() => decodeDialogPaths("not json")).toThrow();
		expect(() => decodeDialogPaths('{"path":"/tmp/file"}')).toThrow(
			"Invalid file-dialog path payload",
		);
		expect(() => decodeDialogPaths('["/tmp/file",42]')).toThrow(
			"Invalid file-dialog path payload",
		);
	});
});
