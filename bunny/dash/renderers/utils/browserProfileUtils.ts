/**
 * Utility functions for browser profile creation and naming
 */

/**
 * Extracts a clean domain name from a URL hostname, removing common short subdomains
 * @param url - The URL to extract from
 * @returns The cleaned hostname of the URL or empty string if invalid
 */
export function extractHostnameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;
    
    // Split hostname into parts
    const parts = hostname.split('.');
    
    // If we have at least 3 parts (subdomain.domain.tld) and the first part is 3 chars or less,
    // remove it (e.g., www.google.com -> google.com, api.github.com -> github.com)
    // But keep longer subdomains (e.g., admin.github.com stays as admin.github.com)
    if (parts.length >= 3 && parts[0].length < 4) {
      hostname = parts.slice(1).join('.');
    }
    
    return hostname;
  } catch {
    return "";
  }
}

/**
 * Determines the best name for a browser profile folder based on page title and URL
 * @param pageTitle - The page title (may be empty/undefined)
 * @param url - The page URL
 * @param fallbackName - Default name to use if nothing else works
 * @returns A string suitable for use as a folder name candidate
 */
export function getBrowserProfileNameCandidate(
  pageTitle: string | null | undefined,
  url: string,
  fallbackName: string = "new-browser-profile"
): string {
  const hostname = extractHostnameFromUrl(url);
  
  // If we have a page title and it's different from the hostname, use it
  if (pageTitle && pageTitle.trim() && pageTitle !== hostname) {
    return pageTitle.trim();
  }
  
  // Otherwise use hostname if available
  if (hostname) {
    return hostname;
  }
  
  // Last resort fallback
  return fallbackName;
}

/**
 * Creates a safe, unique browser profile folder name
 * @param pageTitle - The page title (may be empty/undefined)
 * @param url - The page URL
 * @param parentPath - The parent directory path
 * @param makeFileNameSafe - Function to make filename safe
 * @param getUniqueNewName - Function to get unique name
 * @param fallbackName - Default name to use if nothing else works
 * @returns Promise<string> - The final unique folder name
 */
export async function createBrowserProfileFolderName(
  pageTitle: string | null | undefined,
  url: string,
  parentPath: string,
  makeFileNameSafe: (options: { candidateFilename: string }) => Promise<string | undefined>,
  getUniqueNewName: (options: { parentPath: string; baseName: string }) => Promise<string | undefined>,
  fallbackName: string = "new-browser-profile"
): Promise<string> {
  // Get the base name candidate
  const nameCandidate = getBrowserProfileNameCandidate(pageTitle, url, fallbackName);
  
  // Make it filesystem safe
  const safeNameCandidate = await makeFileNameSafe({
    candidateFilename: nameCandidate,
  });
  
  // Make it unique in the target directory
  const uniqueName = await getUniqueNewName({
    parentPath,
    baseName: safeNameCandidate || fallbackName,
  });
  
  return uniqueName || fallbackName;
}