# Multitab Browser

A demonstration of building a multi-tab browser using Electrobun framework.

## Features

- Multiple browser tabs with independent webviews
- Navigation controls (back, forward, refresh, home)
- URL bar with navigation
- Tab management (new, close, switch)
- Bookmark functionality
- History tracking

## Running the Demo

```bash
# Install dependencies
dash install

# Run in development mode
dash run dev

# Build for production
dash electrobun build --env=stable
```

## Architecture

This template demonstrates:
- Using BrowserView for embedded web content
- RPC communication between main process and renderer
- Tab state management
- Keyboard shortcuts
- URL handling and navigation
