# Electrobun Hello World

A simple Electrobun app to get you started with the framework.

## What You'll See

This hello world app demonstrates:
- **Native Window**: A cross-platform desktop window
- **Web-based UI**: Modern HTML, CSS, and JavaScript interface
- **Simple Architecture**: Clean separation between Bun process and UI

## Getting Started

1. Install dependencies:
   ```bash
   bun install
   ```

2. Run in development mode:
   ```bash
   bun run dev
   ```

3. Build for production:
   ```bash
   bun run build
   ```

## Project Structure

```
src/
├── bun/
│   └── index.ts      # Main process - creates and manages windows
└── mainview/
    ├── index.html    # Your app's UI
    ├── index.css     # Styles
    └── index.ts      # View logic
```

## Next Steps

Ready to build something more complex? Check out:

- **[Documentation](https://docs.electrobun.dev)** - Learn about all Electrobun features
- **[Examples](https://github.com/blackboardsh/electrobun/tree/main/playground)** - See advanced features like RPC, menus, and system tray
- **[GitHub](https://github.com/blackboardsh/electrobun)** - Star the repo and join the community

### Add More Features

Want to extend this app? Try adding:
- RPC communication between Bun and webview
- Native menus and system tray
- File dialogs and system integration
- Multiple windows and views

Happy building! 🚀