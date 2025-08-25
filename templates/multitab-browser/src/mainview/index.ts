import Electrobun, { Electroview } from "electrobun/view";

console.log("🌐 Initializing Multitab Browser UI...");

// Create RPC client
const rpc = Electroview.defineRPC({
  maxRequestTime: 10000,
  handlers: {
    requests: {},
    messages: {
      tabUpdated: (tab: any) => {
        console.log("Tab updated:", tab);
        if ((window as any).multitabBrowser) {
          (window as any).multitabBrowser.handleTabUpdate(tab);
        }
      },
      tabClosed: ({ id }: { id: string }) => {
        console.log("Tab closed:", id);
        if ((window as any).multitabBrowser) {
          (window as any).multitabBrowser.handleTabClosed(id);
        }
      },
    }
  }
});

// Initialize Electrobun with RPC
const electrobun = new Electrobun.Electroview({ rpc });

class MultitabBrowser {
  private tabs: Map<string, any> = new Map();
  private webviews: Map<string, HTMLElement> = new Map();
  private activeTabId: string | null = null;
  private bookmarks: Map<string, any> = new Map();

  constructor() {
    // Store reference globally for RPC message handlers
    (window as any).multitabBrowser = this;
    
    this.initializeUI();
    this.loadBookmarks();
  }

  private initializeUI(): void {
    // New tab button
    document.getElementById("new-tab-btn")?.addEventListener("click", () => {
      this.createNewTab();
    });

    // URL bar navigation
    const urlBar = document.getElementById("url-bar") as HTMLInputElement;
    urlBar?.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        const url = urlBar.value.trim();
        if (url) {
          try {
            // Process URL
            let processedUrl = url;
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
              if (url.includes(".") && !url.includes(" ")) {
                processedUrl = `https://${url}`;
              } else {
                processedUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
              }
            }
            
            // If no active tab, create a new one with this URL
            if (!this.activeTabId) {
              await this.createNewTab(processedUrl);
              return;
            }
            
            // Navigate the existing webview
            const webview = this.webviews.get(this.activeTabId) as any;
            if (webview) {
              webview.src = processedUrl;
            }
            
            // Update tab info
            const tab = this.tabs.get(this.activeTabId);
            if (tab) {
              tab.url = processedUrl;
              this.handleTabUpdate(tab);
            }
            
            await rpc.request.navigateTo({ tabId: this.activeTabId, url: processedUrl });
          } catch (error) {
            console.error("Failed to navigate:", error);
          }
        }
      }
    });

    // Navigation buttons
    document.getElementById("back-btn")?.addEventListener("click", async () => {
      if (this.activeTabId) {
        const webview = this.webviews.get(this.activeTabId) as any;
        if (webview && webview.goBack) {
          webview.goBack();
        }
      }
    });

    document.getElementById("forward-btn")?.addEventListener("click", async () => {
      if (this.activeTabId) {
        const webview = this.webviews.get(this.activeTabId) as any;
        if (webview && webview.goForward) {
          webview.goForward();
        }
      }
    });

    document.getElementById("reload-btn")?.addEventListener("click", async () => {
      if (this.activeTabId) {
        const webview = this.webviews.get(this.activeTabId) as any;
        if (webview && webview.reload) {
          webview.reload();
        }
      }
    });

    document.getElementById("home-btn")?.addEventListener("click", async () => {
      const homeUrl = "https://electrobun.dev";
      
      if (this.activeTabId) {
        // Navigate existing tab to home
        const webview = this.webviews.get(this.activeTabId) as any;
        if (webview) {
          webview.src = homeUrl;
          
          // Update tab info
          const tab = this.tabs.get(this.activeTabId);
          if (tab) {
            tab.url = homeUrl;
            this.handleTabUpdate(tab);
          }
        }
      } else {
        // Create new tab with home URL
        await this.createNewTab(homeUrl);
      }
    });

    // Bookmark button
    document.getElementById("bookmark-btn")?.addEventListener("click", () => {
      this.toggleBookmark();
    });

    // Bookmarks menu button
    const bookmarksMenuBtn = document.getElementById("bookmarks-menu-btn");
    console.log("Found bookmarks menu button:", bookmarksMenuBtn);
    bookmarksMenuBtn?.addEventListener("click", (e) => {
      console.log("Bookmarks menu button clicked");
      e.stopPropagation();
      this.toggleBookmarksMenu();
    });

    // Reset bookmarks button (delegate to handle dynamically added buttons)
    document.addEventListener("click", (e) => {
      if ((e.target as HTMLElement)?.id === "reset-bookmarks-btn") {
        e.preventDefault();
        e.stopPropagation();
        console.log("Reset button clicked");
        this.resetBookmarks();
      }
    });


    // Close bookmarks dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const dropdown = document.getElementById("bookmarks-dropdown");
      const menuBtn = document.getElementById("bookmarks-menu-btn");
      const resetBtn = document.getElementById("reset-bookmarks-btn");
      if (dropdown && !dropdown.contains(e.target as Node) && e.target !== menuBtn && e.target !== resetBtn) {
        dropdown.classList.add("hidden");
      }
    });

    // Keyboard shortcuts - support both Cmd (Mac) and Ctrl (Windows/Linux)
    document.addEventListener("keydown", (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifierPressed = isMac ? e.metaKey : e.ctrlKey;
      
      // Also support the opposite modifier for cross-platform compatibility
      const altModifierPressed = isMac ? e.ctrlKey : e.metaKey;
      
      if ((modifierPressed || altModifierPressed) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        this.createNewTab();
      }
      
      if ((modifierPressed || altModifierPressed) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (this.activeTabId) {
          this.closeTab(this.activeTabId);
        }
      }
      
      if ((modifierPressed || altModifierPressed) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const urlBar = document.getElementById("url-bar") as HTMLInputElement;
        urlBar?.focus();
        urlBar?.select();
      }
    });

    // Show welcome screen initially
    this.showWelcomeScreen();
  }

  private async createNewTab(url?: string): Promise<void> {
    try {
      const tab = await rpc.request.createTab({ url });
      this.tabs.set(tab.id, tab);
      
      // Create electrobun-webview element for this tab
      const webview = document.createElement('electrobun-webview');
      webview.setAttribute('src', tab.url);
      webview.setAttribute('id', `webview-${tab.id}`);
      webview.setAttribute('masks', '#bookmarks-dropdown');
      webview.setAttribute('renderer', 'cef');
      webview.classList.add('tab-webview');
      
      // Add webview to container
      const container = document.getElementById('webview-container');
      if (container) {
        container.appendChild(webview);
      }
      
      this.webviews.set(tab.id, webview);
      
      // Set up webview event listeners
      webview.addEventListener('page-title-updated', (e: any) => {
        const updatedTab = this.tabs.get(tab.id);
        if (updatedTab) {
          updatedTab.title = e.detail?.title || 'New Tab';
          this.handleTabUpdate(updatedTab);
        }
      });
      
      webview.addEventListener('did-navigate', (e: any) => {
        const updatedTab = this.tabs.get(tab.id);
        if (updatedTab && e.detail?.url) {
          updatedTab.url = e.detail.url;
          this.handleTabUpdate(updatedTab);
        }
      });
      
      this.renderTab(tab);
      this.switchToTab(tab.id);
    } catch (error) {
      console.error("Failed to create tab:", error);
    }
  }

  private renderTab(tab: any): void {
    const tabsContainer = document.getElementById("tabs-container");
    if (!tabsContainer) return;

    const tabElement = document.createElement("div");
    tabElement.className = "tab";
    tabElement.id = `tab-${tab.id}`;
    tabElement.innerHTML = `
      <span class="tab-title">${this.truncateTitle(tab.title)}</span>
      <button class="tab-close" data-tab-id="${tab.id}">×</button>
    `;

    tabElement.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).classList.contains("tab-close")) {
        this.switchToTab(tab.id);
      }
    });

    tabElement.querySelector(".tab-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });

    tabsContainer.appendChild(tabElement);
  }

  private async switchToTab(tabId: string): Promise<void> {
    try {
      // Update UI immediately
      document.querySelectorAll(".tab").forEach(tab => {
        tab.classList.remove("active");
      });
      document.getElementById(`tab-${tabId}`)?.classList.add("active");

      // Hide all webviews
      this.webviews.forEach((webview) => {
        // webview.classList.remove('active');
        webview.toggleHidden(true)
        webview.togglePassthrough(true)
      });
      
      // Show the selected webview
      const selectedWebview = this.webviews.get(tabId);
      if (selectedWebview) {
        selectedWebview.classList.add('active');
        selectedWebview.toggleHidden(false)
        selectedWebview.togglePassthrough(false)
      }

      this.activeTabId = tabId;
      const tab = this.tabs.get(tabId);
      
      if (tab) {
        const urlBar = document.getElementById("url-bar") as HTMLInputElement;
        if (urlBar) {
          urlBar.value = tab.url;
        }
        
        this.updateBookmarkButton();
        this.hideWelcomeScreen();
      }

      // Notify backend about tab switch (optional)
      await rpc.request.activateTab({ tabId });
    } catch (error) {
      console.error("Failed to switch tab:", error);
    }
  }

  private async closeTab(tabId: string): Promise<void> {
    try {
      console.log(`Closing tab ${tabId}, active tab: ${this.activeTabId}, total tabs before: ${this.tabs.size}`);
      
      await rpc.request.closeTab({ id: tabId });
      this.tabs.delete(tabId);
      
      // Remove the webview element
      const webview = this.webviews.get(tabId);
      if (webview) {
        webview.remove();
        this.webviews.delete(tabId);
      }
      
      document.getElementById(`tab-${tabId}`)?.remove();

      const remainingTabs = Array.from(this.tabs.keys());
      console.log(`Remaining tabs after close: ${remainingTabs.length}`, remainingTabs);

      // Check if this was the active tab
      if (this.activeTabId === tabId) {
        console.log("Closed the active tab");
        this.activeTabId = null;
        
        if (remainingTabs.length > 0) {
          console.log("Switching to remaining tab:", remainingTabs[remainingTabs.length - 1]);
          this.switchToTab(remainingTabs[remainingTabs.length - 1]);
        } else {
          console.log("No tabs left - showing welcome screen");
          this.showWelcomeScreen();
        }
      } else {
        console.log("Closed a non-active tab");
        if (remainingTabs.length === 0) {
          console.log("No tabs left after closing non-active tab - showing welcome screen");
          this.activeTabId = null;
          this.showWelcomeScreen();
        }
      }
    } catch (error) {
      console.error("Failed to close tab:", error);
    }
  }

  public handleTabUpdate(tab: any): void {
    this.tabs.set(tab.id, tab);
    
    const tabElement = document.getElementById(`tab-${tab.id}`);
    if (tabElement) {
      const titleElement = tabElement.querySelector(".tab-title");
      if (titleElement) {
        titleElement.textContent = this.truncateTitle(tab.title);
      }
    }

    if (this.activeTabId === tab.id) {
      const urlBar = document.getElementById("url-bar") as HTMLInputElement;
      if (urlBar && document.activeElement !== urlBar) {
        urlBar.value = tab.url;
      }
      this.updateBookmarkButton();
    }
  }

  public handleTabClosed(id: string): void {
    this.tabs.delete(id);
    document.getElementById(`tab-${id}`)?.remove();
  }

  private showWelcomeScreen(): void {
    const welcome = document.getElementById("welcome-screen");
    const webview = document.getElementById("webview-container");
    if (welcome) welcome.style.display = "flex";
    if (webview) webview.style.display = "none";
    
    const urlBar = document.getElementById("url-bar") as HTMLInputElement;
    if (urlBar) urlBar.value = "";
  }

  private hideWelcomeScreen(): void {
    const welcome = document.getElementById("welcome-screen");
    const webview = document.getElementById("webview-container");
    if (welcome) welcome.style.display = "none";
    if (webview) webview.style.display = "block";
  }

  private truncateTitle(title: string, maxLength: number = 20): string {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + "...";
  }

  private async loadBookmarks(): Promise<void> {
    try {
      // Load bookmarks from localStorage or backend
      const stored = localStorage.getItem('bookmarks');
      if (stored) {
        const bookmarksArray = JSON.parse(stored);
        bookmarksArray.forEach((bookmark: any) => {
          this.bookmarks.set(bookmark.url, bookmark);
        });
      } else {
        // Add default bookmarks
        this.addBookmark("Electrobun", "https://electrobun.dev");
        this.addBookmark("Electrobun GitHub", "https://github.com/blackboardsh/electrobun");
        this.addBookmark("Yoav on Bluesky", "https://bsky.app/profile/yoav.codes");
        this.addBookmark("Blackboard", "https://www.blackboard.sh");
      }
      this.renderBookmarks();
      this.renderQuickLinks();
    } catch (error) {
      console.error("Failed to load bookmarks:", error);
    }
  }

  private saveBookmarks(): void {
    const bookmarksArray = Array.from(this.bookmarks.values());
    localStorage.setItem('bookmarks', JSON.stringify(bookmarksArray));
  }

  private resetBookmarks(): void {
    console.log("resetBookmarks called - resetting without confirmation");
    
    // Clear existing bookmarks
    this.bookmarks.clear();
    localStorage.removeItem('bookmarks');
    
    // Add default bookmarks with unique IDs
    let counter = 0;
    const addDefaultBookmark = (title: string, url: string) => {
      const bookmark = {
        id: `bookmark-default-${counter++}`,
        title,
        url,
        createdAt: Date.now() + counter
      };
      this.bookmarks.set(url, bookmark);
      console.log("Added bookmark:", bookmark);
    };
    
    addDefaultBookmark("Electrobun", "https://electrobun.dev");
    addDefaultBookmark("Electrobun GitHub", "https://github.com/blackboardsh/electrobun");
    addDefaultBookmark("Yoav on Bluesky", "https://bsky.app/profile/yoav.codes");
    addDefaultBookmark("Blackboard", "https://www.blackboard.sh");
    
    // Save and re-render
    this.saveBookmarks();
    this.renderBookmarks();
    this.renderQuickLinks();
    this.updateBookmarkButton();
    
    console.log("Bookmarks reset completed, total bookmarks:", this.bookmarks.size);
  }

  private addBookmark(title: string, url: string): void {
    const bookmark = {
      id: `bookmark-${Date.now()}`,
      title,
      url,
      createdAt: Date.now()
    };
    this.bookmarks.set(url, bookmark);
    this.saveBookmarks();
  }

  private removeBookmark(url: string): void {
    this.bookmarks.delete(url);
    this.saveBookmarks();
  }

  private toggleBookmark(): void {
    if (!this.activeTabId) return;
    
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;

    const bookmarkBtn = document.getElementById("bookmark-btn");
    if (!bookmarkBtn) return;

    if (this.bookmarks.has(tab.url)) {
      // Remove bookmark
      this.removeBookmark(tab.url);
      bookmarkBtn.classList.remove("bookmarked");
    } else {
      // Add bookmark
      this.addBookmark(tab.title || "Untitled", tab.url);
      bookmarkBtn.classList.add("bookmarked");
    }

    this.renderBookmarks();
    this.renderQuickLinks();
  }

  private updateBookmarkButton(): void {
    const bookmarkBtn = document.getElementById("bookmark-btn");
    if (!bookmarkBtn || !this.activeTabId) return;

    const tab = this.tabs.get(this.activeTabId);
    if (tab && this.bookmarks.has(tab.url)) {
      bookmarkBtn.classList.add("bookmarked");
    } else {
      bookmarkBtn.classList.remove("bookmarked");
    }
  }

  private toggleBookmarksMenu(): void {
    const dropdown = document.getElementById("bookmarks-dropdown");
    if (dropdown) {
      console.log("Toggling bookmarks menu, current hidden:", dropdown.classList.contains("hidden"));
      dropdown.classList.toggle("hidden");
    } else {
      console.error("Bookmarks dropdown not found");
    }
  }

  private renderBookmarks(): void {
    const bookmarksList = document.getElementById("bookmarks-list");
    if (!bookmarksList) return;

    bookmarksList.innerHTML = "";
    
    if (this.bookmarks.size === 0) {
      bookmarksList.innerHTML = '<div class="no-bookmarks">No bookmarks yet</div>';
      return;
    }

    this.bookmarks.forEach(bookmark => {
      const item = document.createElement("div");
      item.className = "bookmark-item";
      item.innerHTML = `
        <div class="bookmark-info">
          <div class="bookmark-title">${bookmark.title}</div>
          <div class="bookmark-url">${this.truncateUrl(bookmark.url)}</div>
        </div>
        <button class="bookmark-delete" data-url="${bookmark.url}">×</button>
      `;

      item.querySelector(".bookmark-info")?.addEventListener("click", async () => {
        if (this.activeTabId) {
          // Navigate current tab
          const webview = this.webviews.get(this.activeTabId) as any;
          if (webview) {
            webview.src = bookmark.url;
            const tab = this.tabs.get(this.activeTabId);
            if (tab) {
              tab.url = bookmark.url;
              this.handleTabUpdate(tab);
            }
          }
        } else {
          // Create new tab with bookmark
          await this.createNewTab(bookmark.url);
        }
        // Hide dropdown
        const dropdown = document.getElementById("bookmarks-dropdown");
        if (dropdown) {
          dropdown.classList.add("hidden");
        }
      });

      item.querySelector(".bookmark-delete")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const url = (e.currentTarget as HTMLElement).dataset.url;
        if (url) {
          this.removeBookmark(url);
          this.renderBookmarks();
          this.renderQuickLinks();
          this.updateBookmarkButton();
        }
      });

      bookmarksList.appendChild(item);
    });
  }

  private renderQuickLinks(): void {
    const container = document.getElementById("quick-links-container");
    if (!container) return;

    container.innerHTML = "";
    
    // Show first 6 bookmarks as quick links
    const bookmarksArray = Array.from(this.bookmarks.values());
    bookmarksArray.slice(0, 6).forEach(bookmark => {
      const link = document.createElement("button");
      link.className = "quick-link";
      link.innerHTML = `
        <div class="quick-link-favicon">🌐</div>
        <div class="quick-link-title">${this.truncateTitle(bookmark.title, 15)}</div>
      `;
      link.addEventListener("click", () => {
        this.createNewTab(bookmark.url);
      });
      container.appendChild(link);
    });
  }

  private truncateUrl(url: string, maxLength: number = 40): string {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + "...";
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    new MultitabBrowser();
  });
} else {
  new MultitabBrowser();
}