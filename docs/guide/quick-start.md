---
title: "Quick Start"
---

Welcome to Electrobun! This guide will help you create your first ultra-fast, tiny desktop application with TypeScript.

## Prerequisites
Before getting started, make sure you have:

- [Bun](https://bun.sh) installed on your system

- A text editor or IDE (Blackboard's own [co(lab)](https://blackboard.sh/colab/) recommended)

- Basic knowledge of TypeScript/JavaScript

## Getting Started
Create a new Electrobun project with a single command:

```

bunx electrobun init

```

It'll ask you which template project you want to get started with.This creates a new directory with the basic project structure:

```

my-app/
├── src/
│   ├── bun/
│   │   └── index.ts        # Bun entry point (main process)
│   └── mainview/
│       ├── index.html      # UI template
│       ├── index.css       # Styles
│       └── index.ts        # Frontend logic
├── package.json            # Project dependencies
├── tsconfig.json
└── electrobun.config.ts    # Build configuration

```

## Running Your App
Navigate to your project directory and start development:

```

cd my-app
bun install
bun start

```

This will use the Electrobun cli:

- Create a quick start project on your machine

- Use the Electrobun cli to do a dev build of your app

- Open your app in dev mode

## Next Steps
Now that you have a basic app running, explore these topics:

- [Hello World](/guide/hello-world) - Create a hello world from scratch.

- [Creating UI](/guide/creating-ui) - Build beautiful interfaces with web technologies

- [Bun API](/api/bun) - Learn about the main process APIs

- [BrowserView](/api/browser-view) - Manage multiple webviews

- [Bundling & Distribution](/guide/bundling-and-distribution) - Package your app for distribution

## Need Help?
If you run into any issues:

- Check the [GitHub repository](https://github.com/blackboardsh/electrobun)

- Join our [Discord community](https://discord.gg/ueKE4tjaCE)

- Read through the other documentation guides
