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
const utfHelper = readFileSync(
	join(import.meta.dirname, "../native/shared/windows_utf.h"),
	"utf8",
);
const resourceHelper = readFileSync(
	join(import.meta.dirname, "../native/shared/windows_resource_paths.h"),
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
		expect(wrapper).not.toContain("GetCurrentDirectoryA");
		expect(wrapper).not.toContain("GetFileAttributesA");
		expect(wrapper).not.toContain("CreateDirectoryA");
	});

	test("opens views resources and ASAR archives through wide filesystem paths", () => {
		expect(wrapper).toContain('#include "../shared/windows_resource_paths.h"');
		expect(wrapper).toContain(
			"static AsarArchive* open(const std::filesystem::path& path)",
		);
		expect(wrapper).toContain("electrobun::windowsResourcesDirectory()");
		expect(wrapper).toContain("electrobun::readWindowsBinaryFile(");
		expect(resourceHelper).toContain("getModuleFileNameWide()");
		expect(resourceHelper).toContain("windowsExtendedLengthPath(");
		expect(resourceHelper).toContain("std::ifstream file(");
	});

	test("routes WebView2 and CEF profile paths through wide helpers", () => {
		expect(wrapper).toContain('getEnvironmentVariableWide(L"LOCALAPPDATA")');
		expect(wrapper).toContain("buildWebView2UserDataPath(");
		expect(wrapper).toContain("buildCEFPartitionPath(");
		expect(wrapper).toContain("SHCreateDirectoryExW(");
		expect(wrapper).toContain("CefString(&settings.cache_path) = userDataDir");
	});

	test("uses strict UTF-8 and UTF-16 conversion APIs", () => {
		expect(helper).toContain('#include "windows_utf.h"');
		expect(utfHelper).toContain("MultiByteToWideChar(");
		expect(utfHelper).toContain("MB_ERR_INVALID_CHARS");
		expect(utfHelper).toContain("WideCharToMultiByte(");
		expect(utfHelper).toContain("WC_ERR_INVALID_CHARS");
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
		expect(cacheMigration).toContain(
			"constexpr uint32_t WINDOWS_CEF_CACHE_FORMAT_VERSION = 4;",
		);
	});

	test("encodes every Windows CEF partition name", () => {
		expect(helper).toContain("buildWindowsCEFPartitionDirectoryName(");
		expect(helper).toContain('encodedPrefix = "__electrobun_partition_"');
		expect(helper).toContain("for (const unsigned char ch : partitionName)");
		expect(wrapper).toContain("buildWindowsCEFPartitionDirectoryName(partitionName)");
	});

	test("atomically replaces the Windows sentinel and rejects partial wipes", () => {
		expect(cacheMigration).toContain("MoveFileExW(");
		expect(cacheMigration).toContain("MOVEFILE_REPLACE_EXISTING");
		expect(cacheMigration).not.toContain(
			"std::filesystem::remove(sentinelPath",
		);
		expect(cacheMigration).toContain(
			"entry.path().filename() == sentinelPath.filename()",
		);
		expect(cacheMigration).toContain("if (!wipeComplete)");
		expect(cacheMigration).toContain(
			"leaving the old format sentinel for retry",
		);
		expect(wrapper).toContain(
			"electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION",
		);
	});
});
