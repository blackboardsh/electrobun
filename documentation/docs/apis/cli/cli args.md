## CLI Tool Integration

When you execute `bun install electrobun`, it installs the Electrobun CLI tool into the `node_modules/bin` folder. This setup enables your npm scripts to simply invoke `electrobun <args>` directly, utilizing the CLI seamlessly.

The CLI leverages the `electrobun.config` file to manage commands and handle processes associated with building and running the application efficiently.

### Installation

To install the CLI tool, use the following command:

```bash
bun install electrobun
```

This command integrates the Electrobun CLI into your project's `node_modules` directory, making it accessible for npm scripts or direct command-line usage within the project environment.

## Commands

### init

**Description**: Initializes a new Electrobun project structure.  
**Status**: Not yet implemented.

### build

**Description**: Compiles the project according to configurations specified in the `electrobun.config`.

### dev

**Description**: Facilitates the project running in a development environment with live reloading, providing real-time feedback during development phases.

### launcher

**Description**: Manages application launching, adapting to different settings for development and production environments to ensure appropriate resource utilization.

## Environments

### env

**Description**: Specifies the build environment, which can be set to `dev`, `canary`, or `stable`. Non-dev environments like `canary` and `stable` lead to the generation of an `artifacts` folder, containing all necessary distribution files. These files can be hosted on static file services for application distribution.

## Example Build Scripts

Incorporating Electrobun into your `package.json` scripts can streamline both development and build processes:

```json
"scripts": {
"build:dev": "electrobun build",
"start:dev": "electrobun dev",
"dev": "bun install && npm run build:dev && npm run start:dev",
"build:canary": "electrobun build env=canary",
"build:stable": "electrobun build env=stable"
}
```

## Development vs. Production Builds

### Development Build (`dev`)

In the development environment, the build configuration is designed to output logs and errors directly to the terminal window, ensuring immediate feedback and error reporting for enhanced developer intervention.

### Canary and Stable Builds

For environments marked as `canary` and `stable`, the CLI employs an optimized launcher binary better suited for production deployments. This launcher is optimized for performance and stability, ensuring efficient application execution.

#### Canary

Typically utilized for pre-release versions or testing new features in conditions that closely mimic production.

#### Stable

Used for releasing final, production-ready builds that are distributed to end-users.

### Optimized Launcher Binary

The optimized launcher binary is not merely for launching the application; it is also engineered to handle updates, system integration, and other critical runtime operations more reliably than the development-based launcher. This optimization ensures peak performance in environments where direct developer oversight is minimized.
