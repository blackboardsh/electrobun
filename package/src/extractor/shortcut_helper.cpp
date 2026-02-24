#include <windows.h>
#include <shlobj.h>
#include <propkey.h>
#include <propvarutil.h>
#include <iostream>
#include <fstream>
#include <string>

static void log_to_file(const std::string& message) {
    char temp_path[MAX_PATH];
    GetTempPathA(MAX_PATH, temp_path);
    std::string log_path = std::string(temp_path) + "electrobun-shortcut.log";
    
    std::ofstream log_file(log_path, std::ios::app);
    if (log_file.is_open()) {
        DWORD pid = GetCurrentProcessId();
        DWORD tid = GetCurrentThreadId();
        log_file << "[SHORTCUT] PID=" << pid << " TID=" << tid << " " << message << std::endl;
        log_file.close();
    }
}

extern "C" {

__declspec(dllexport) HRESULT CreateShortcutWithAppId(
    const wchar_t* shortcut_path,
    const wchar_t* target_path,
    const wchar_t* working_dir,
    const wchar_t* icon_path,
    const wchar_t* app_id,
    const wchar_t* description
) {
    HRESULT hr;
    
    log_to_file("CreateShortcutWithAppId called");
    
    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        log_to_file("CoInitializeEx failed: 0x" + std::to_string(hr));
        return hr;
    }
    
    IShellLinkW* pShellLink = NULL;
    IPropertyStore* pPropertyStore = NULL;
    IPersistFile* pPersistFile = NULL;
    
    hr = CoCreateInstance(
        CLSID_ShellLink,
        NULL,
        CLSCTX_INPROC_SERVER,
        IID_IShellLinkW,
        (LPVOID*)&pShellLink
    );
    
    if (FAILED(hr)) {
        log_to_file("CoCreateInstance(IShellLink) failed: 0x" + std::to_string(hr));
        CoUninitialize();
        return hr;
    }
    
    log_to_file("IShellLink created successfully");
    
    hr = pShellLink->SetPath(target_path);
    if (FAILED(hr)) {
        log_to_file("SetPath failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    hr = pShellLink->SetWorkingDirectory(working_dir);
    if (FAILED(hr)) {
        log_to_file("SetWorkingDirectory failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    hr = pShellLink->SetIconLocation(icon_path, 0);
    if (FAILED(hr)) {
        log_to_file("SetIconLocation failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    if (description && wcslen(description) > 0) {
        hr = pShellLink->SetDescription(description);
        if (FAILED(hr)) {
            log_to_file("SetDescription failed: 0x" + std::to_string(hr));
        }
    }
    
    log_to_file("Basic shortcut properties set");
    
    hr = pShellLink->QueryInterface(IID_IPropertyStore, (LPVOID*)&pPropertyStore);
    if (FAILED(hr)) {
        log_to_file("QueryInterface(IPropertyStore) failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    log_to_file("IPropertyStore obtained");
    
    {
        PROPVARIANT pv;
        hr = InitPropVariantFromString(app_id, &pv);
        if (SUCCEEDED(hr)) {
            hr = pPropertyStore->SetValue(PKEY_AppUserModel_ID, pv);
            PropVariantClear(&pv);
            
            if (FAILED(hr)) {
                log_to_file("SetValue(PKEY_AppUserModel_ID) failed: 0x" + std::to_string(hr));
                goto cleanup;
            }
            
            log_to_file("PKEY_AppUserModel_ID set successfully");
        } else {
            log_to_file("InitPropVariantFromString failed: 0x" + std::to_string(hr));
            goto cleanup;
        }
    }
    
    hr = pPropertyStore->Commit();
    if (FAILED(hr)) {
        log_to_file("IPropertyStore::Commit failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    log_to_file("Property changes committed");
    
    hr = pShellLink->QueryInterface(IID_IPersistFile, (LPVOID*)&pPersistFile);
    if (FAILED(hr)) {
        log_to_file("QueryInterface(IPersistFile) failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    hr = pPersistFile->Save(shortcut_path, TRUE);
    if (FAILED(hr)) {
        log_to_file("IPersistFile::Save failed: 0x" + std::to_string(hr));
        goto cleanup;
    }
    
    log_to_file("Shortcut saved successfully: 0x0");
    
cleanup:
    if (pPersistFile) pPersistFile->Release();
    if (pPropertyStore) pPropertyStore->Release();
    if (pShellLink) pShellLink->Release();
    CoUninitialize();
    
    return hr;
}

}
