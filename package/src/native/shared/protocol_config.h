#ifndef ELECTROBUN_PROTOCOL_CONFIG_H
#define ELECTROBUN_PROTOCOL_CONFIG_H

#include <algorithm>
#include <cctype>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace electrobun {

struct ProtocolPrivileges {
	bool standard = false;
	bool secure = false;
	bool bypassCSP = false;
	bool allowServiceWorkers = false;
	bool supportFetchAPI = false;
	bool corsEnabled = false;
	bool stream = false;
	bool codeCache = false;
};

struct ProtocolRegistration {
	std::string scheme;
	ProtocolPrivileges privileges;
};

inline std::mutex& protocolConfigMutex() {
	static std::mutex mutex;
	return mutex;
}

inline std::vector<ProtocolRegistration>& protocolConfigStore() {
	static std::vector<ProtocolRegistration> store;
	return store;
}

// Stored alongside the parsed vector so it can be forwarded to CEF renderer
// child processes verbatim via the --electrobun-custom-protocols command-line switch.
inline std::string& protocolConfigRawJSON() {
	static std::string raw;
	return raw;
}

inline std::string normalizeProtocolScheme(const std::string& scheme) {
	std::string normalized = scheme;
	std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
		return static_cast<char>(std::tolower(ch));
	});
	return normalized;
}

inline bool readProtocolBoolean(const std::string& object, const std::string& key, bool fallback) {
	std::string pattern = std::string("\"") + key + "\":";
	size_t pos = object.find(pattern);
	if (pos == std::string::npos) {
		return fallback;
	}
	pos += pattern.size();
	while (pos < object.size() && std::isspace(static_cast<unsigned char>(object[pos]))) {
		pos++;
	}
	if (object.compare(pos, 4, "true") == 0) {
		return true;
	}
	if (object.compare(pos, 5, "false") == 0) {
		return false;
	}
	return fallback;
}

// Simple JSON scanner for well-formed output from JSON.stringify. Assumes no escaped
// quotes in scheme names or privilege keys. For internal use only - input is trusted
// output from the Bun side.
inline std::vector<ProtocolRegistration> parseProtocolConfigJson(const std::string& json) {
	std::vector<ProtocolRegistration> protocols;
	size_t pos = 0;

	while ((pos = json.find("\"scheme\"", pos)) != std::string::npos) {
		size_t schemeStart = json.find('"', pos + 8);
		if (schemeStart == std::string::npos) {
			break;
		}
		schemeStart++;
		size_t schemeEnd = json.find('"', schemeStart);
		if (schemeEnd == std::string::npos) {
			break;
		}

		std::string scheme = normalizeProtocolScheme(json.substr(schemeStart, schemeEnd - schemeStart));
		size_t objectStart = json.rfind('{', pos);
		size_t objectEnd = json.find('}', schemeEnd);
		std::string object = objectStart != std::string::npos && objectEnd != std::string::npos
			? json.substr(objectStart, objectEnd - objectStart + 1)
			: json.substr(pos);

		ProtocolRegistration registration;
		registration.scheme = scheme;
		registration.privileges.standard = readProtocolBoolean(object, "standard", true);
		registration.privileges.secure = readProtocolBoolean(object, "secure", true);
		registration.privileges.bypassCSP = readProtocolBoolean(object, "bypassCSP", false);
		registration.privileges.allowServiceWorkers = readProtocolBoolean(object, "allowServiceWorkers", false);
		registration.privileges.supportFetchAPI = readProtocolBoolean(object, "supportFetchAPI", true);
		registration.privileges.corsEnabled = readProtocolBoolean(object, "corsEnabled", true);
		registration.privileges.stream = readProtocolBoolean(object, "stream", true);
		registration.privileges.codeCache = readProtocolBoolean(object, "codeCache", false);

		if (!registration.scheme.empty() && registration.scheme != "views") {
			protocols.push_back(registration);
		}

		pos = schemeEnd + 1;
	}

	return protocols;
}

inline std::string extractProtocolsJson(const std::string& buildJson) {
	std::string key = "\"protocols\"";
	size_t keyPos = buildJson.find(key);
	if (keyPos == std::string::npos) {
		return "[]";
	}

	size_t arrayStart = buildJson.find('[', keyPos + key.length());
	if (arrayStart == std::string::npos) {
		return "[]";
	}

	int depth = 1;
	size_t arrayEnd = arrayStart + 1;
	while (arrayEnd < buildJson.size() && depth > 0) {
		if (buildJson[arrayEnd] == '[') depth++;
		else if (buildJson[arrayEnd] == ']') depth--;
		arrayEnd++;
	}

	if (depth != 0) {
		return "[]";
	}

	return buildJson.substr(arrayStart, arrayEnd - arrayStart);
}

inline void setProtocolConfigJson(const std::string& json) {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	protocolConfigRawJSON() = json;
	protocolConfigStore() = parseProtocolConfigJson(json);
}

inline void loadProtocolConfigFromBuildJson(const std::string& buildJson) {
	setProtocolConfigJson(extractProtocolsJson(buildJson));
}

inline std::string getProtocolConfigJson() {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	return protocolConfigRawJSON();
}

inline std::vector<ProtocolRegistration> getProtocolRegistrations() {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	return protocolConfigStore();
}

inline bool hasProtocolRegistration(const std::string& scheme) {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	std::string normalized = normalizeProtocolScheme(scheme);
	for (const auto& registration : protocolConfigStore()) {
		if (registration.scheme == normalized) {
			return true;
		}
	}
	return false;
}

inline std::optional<ProtocolRegistration> findProtocolRegistration(const std::string& scheme) {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	std::string normalized = normalizeProtocolScheme(scheme);
	for (const auto& registration : protocolConfigStore()) {
		if (registration.scheme == normalized) {
			return registration;
		}
	}
	return std::nullopt;
}

template <typename RegistrarFn>
inline void forEachProtocolRegistration(RegistrarFn&& fn) {
	std::lock_guard<std::mutex> lock(protocolConfigMutex());
	for (const auto& registration : protocolConfigStore()) {
		fn(registration);
	}
}

}

#endif
