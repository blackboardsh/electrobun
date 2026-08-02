import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const wrapper = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
	"utf8",
);
const helper = readFileSync(
	join(import.meta.dirname, "../native/shared/windows_profile_paths.h"),
	"utf8",
);
const appPaths = readFileSync(
	join(import.meta.dirname, "../native/shared/app_paths.h"),
	"utf8",
);
const cacheMigration = readFileSync(
	join(import.meta.dirname, "../native/shared/cache_migration.h"),
	"utf8",
);

describe("Windows profile path source contract", () => {
	test("does not use ANSI filesystem APIs for renderer startup paths", () => {
		expect(wrapper).not.toContain('getenv("LOCALAPPDATA")');
		expect(wrapper).not.toContain("GetModuleFileNameA");
		expect(wrapper).not.toContain("GetFileAttributesA");
		expect(wrapper).not.toContain("CreateDirectoryA");
	});

	test("routes WebView2 and CEF profile paths through wide helpers", () => {
		expect(wrapper).toContain('getEnvironmentVariableWide(L"LOCALAPPDATA")');
		expect(wrapper).toContain("buildWebView2UserDataPath(");
		expect(wrapper).toContain("buildCEFPartitionPath(");
		expect(wrapper).toContain("SHCreateDirectoryExW(");
		expect(wrapper).toContain("CefString(&settings.cache_path) = userDataDir");
	});

	test("uses strict UTF-8 and UTF-16 conversion APIs", () => {
		expect(helper).toContain("MultiByteToWideChar(");
		expect(helper).toContain("MB_ERR_INVALID_CHARS");
		expect(helper).toContain("WideCharToMultiByte(");
		expect(helper).toContain("WC_ERR_INVALID_CHARS");
	});

	test("keeps named CEF profiles directly under root_cache_path", () => {
		const cefPathHelpers = appPaths.slice(
			appPaths.indexOf("inline std::string buildCEFPartitionPath("),
		);
		expect(cefPathHelpers).toContain("base += partitionName;");
		expect(cefPathHelpers).not.toContain('base += "partitions";');
		expect(cacheMigration).toContain(
			"constexpr uint32_t CEF_CACHE_FORMAT_VERSION = 3;",
		);
	});
});
