// asar.h - Cross-platform ASAR archive C FFI declarations
// Used for reading files from ASAR archives across Windows, macOS, and Linux
//
// This is a header-only declaration file. The actual implementation is provided by:
// - libasar library (macOS, Linux)
// - Built-in AsarArchive class (Windows)

#ifndef ELECTROBUN_ASAR_H
#define ELECTROBUN_ASAR_H

#include <cstdint>
#include <cstddef>
#include <mutex>

// C FFI declarations for ASAR archive operations
// These match the libasar library API
extern "C" {
    typedef struct AsarArchive AsarArchive;

    AsarArchive* asar_open(const char* path);
    void asar_close(AsarArchive* archive);
    const uint8_t* asar_read_file(AsarArchive* archive, const char* path, size_t* size_out);
    void asar_free_buffer(const uint8_t* buffer, size_t size);
}

namespace electrobun {

// Global ASAR archive handle (lazy-loaded) with thread-safe initialization
// Each platform should define these in their nativeWrapper implementation
// as: static AsarArchive* g_asarArchive = nullptr;
//     static std::once_flag g_asarArchiveInitFlag;

} // namespace electrobun

#endif // ELECTROBUN_ASAR_H
