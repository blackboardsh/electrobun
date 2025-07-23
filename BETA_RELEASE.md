# Electrobun Beta Releases

## For Users

### Installing Beta Versions

```bash
# Install latest beta
npm install electrobun@beta

# Install specific beta version
npm install electrobun@0.0.19-beta.1

# View available versions
npm view electrobun versions --json
```

### Switching Between Stable and Beta

```bash
# Switch to stable
npm install electrobun@latest

# Switch to beta
npm install electrobun@beta
```

## For Maintainers

### Publishing Beta Releases

1. **Update version:**
   ```bash
   # First beta of a new version
   npm version 0.0.19-beta.1
   
   # Increment beta number
   bun npm:version:beta
   ```

2. **Create GitHub Release:**
   ```bash
   git push origin v0.0.19-beta.1
   ```
   Or manually trigger the workflow with the beta tag.

3. **Publish to npm:**
   ```bash
   bun npm:publish:beta
   ```

### Beta Release Workflow

1. Beta versions use semantic versioning: `MAJOR.MINOR.PATCH-beta.NUMBER`
2. GitHub Actions automatically marks releases with `-beta` as pre-releases
3. npm publishes to the `beta` dist-tag (not `latest`)
4. Users on stable versions won't get beta updates

### Promoting Beta to Stable

```bash
# Update version to stable
npm version 0.0.19

# Publish as latest
bun npm:publish
```