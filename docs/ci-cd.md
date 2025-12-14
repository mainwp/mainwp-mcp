# CI/CD Guide

This guide covers the continuous integration and deployment pipeline for the MainWP MCP Server.

## Overview

The project uses GitHub Actions for automated testing and quality checks on every push to `main` and every pull request targeting `main`.

## CI Pipeline

### Workflow Triggers

The CI workflow runs on:

- **Push** to `main` branch
- **Pull requests** targeting `main` branch

### Matrix Testing

Tests run across multiple Node.js versions to ensure compatibility:

| Node Version | Status    | EOL Date   |
| ------------ | --------- | ---------- |
| 18.x         | Supported | April 2025 |
| 20.x         | Supported | April 2026 |
| 22.x         | Supported | April 2027 |

### Pipeline Steps

Each CI run executes these steps in order:

1. **Checkout** - Clone the repository
2. **Setup Node.js** - Install the matrix Node version with npm caching
3. **Install Dependencies** - Run `npm ci` for clean, reproducible installs
4. **Format Check** - Validate code formatting with Prettier
5. **Lint** - Check code quality with ESLint
6. **Version Consistency** - Verify version sync between files
7. **Build** - Compile TypeScript to JavaScript
8. **Test with Coverage** - Run Vitest tests and generate coverage reports
9. **Upload Coverage** - Send coverage to Codecov (Node 20 only)

### Quality Gates

| Gate           | Tool             | Threshold       | Blocks CI |
| -------------- | ---------------- | --------------- | --------- |
| Format         | Prettier         | 100% compliance | Yes       |
| Lint           | ESLint           | 0 errors        | Yes       |
| Version Sync   | check-version.js | Exact match     | Yes       |
| Build          | TypeScript       | 0 errors        | Yes       |
| Test Coverage  | Vitest           | 70% minimum     | Yes       |
| Codecov Upload | Codecov          | Informational   | No        |

## Running CI Checks Locally

Before pushing, you can run the same checks locally:

```bash
# Format check (same as CI)
npm run format:check

# Fix formatting issues
npm run format

# Lint check (same as CI)
npm run lint

# Fix lint issues
npm run lint:fix

# Version consistency check
npm run check-version

# Build
npm run build

# Test with coverage
npm run test:coverage
```

### Quick Pre-Push Script

Run all checks in sequence:

```bash
npm run format:check && npm run lint && npm run check-version && npm run build && npm run test:coverage
```

## Version Consistency

The server version must be synchronized between two files:

- `package.json` - `"version"` field (line 3)
- `src/index.ts` - `SERVER_VERSION` constant (line 50)

### How to Update Version

Before each build or release:

1. Increment the version in `package.json`
2. Update `SERVER_VERSION` in `src/index.ts` to match
3. Run `npm run check-version` to verify

The project follows [Semantic Versioning 2.0](https://semver.org/) with alpha pre-releases:

```
1.0.0-alpha.N   (current phase)
1.0.0-beta.N    (future)
1.0.0           (future release)
```

### Version Check Script

The `scripts/check-version.js` script:

- Reads version from `package.json`
- Extracts `SERVER_VERSION` from `src/index.ts`
- Exits with code 0 if versions match
- Exits with code 1 if versions differ

## Dependabot

Automated dependency updates are configured via Dependabot:

- **Schedule**: Weekly on Mondays
- **Ecosystem**: npm
- **PR Limit**: 5 open PRs maximum
- **Labels**: `dependencies`
- **Commit Prefix**: `chore(deps):`

### Handling Dependabot PRs

1. Review the changelog and release notes linked in the PR
2. Check if CI passes
3. For major version bumps, review breaking changes carefully
4. Merge if tests pass and changes look safe

## Codecov Integration

Coverage reports are uploaded to Codecov for tracking over time.

### Thresholds

- **Project Coverage Target**: 70%
- **Patch Coverage Target**: 60% (new code)
- **Allowed Drop**: 2% without failing

### Setup

For the Codecov upload to work:

1. Sign up at [codecov.io](https://codecov.io)
2. Add the `mainwp/mainwp-mcp` repository
3. Copy the repository upload token
4. Add it as `CODECOV_TOKEN` in GitHub Settings → Secrets and variables → Actions

For public repositories, Codecov can work without a token, but having one ensures reliable uploads.

### Coverage Reports

Codecov will comment on PRs with:

- Coverage diff for changed files
- Overall project coverage
- Patch coverage for new code

### Ignored Paths

These paths are excluded from coverage:

- `dist/**` - Compiled output
- `coverage/**` - Coverage reports
- `**/*.test.ts` - Test files
- `tests/**` - Test fixtures

## File Structure

```
.github/
├── workflows/
│   └── ci.yml          # GitHub Actions CI pipeline
└── dependabot.yml      # Automated dependency updates

scripts/
└── check-version.js    # Version consistency validator

.codecov.yml            # Codecov coverage configuration
```

## Troubleshooting

### CI Failing on Format Check

```bash
# See what needs formatting
npm run format:check

# Auto-fix formatting
npm run format
```

### CI Failing on Lint

```bash
# See lint errors
npm run lint

# Auto-fix fixable issues
npm run lint:fix
```

### CI Failing on Version Check

```bash
# See which versions don't match
npm run check-version

# Update both files to match
# Edit package.json and src/index.ts
```

### CI Failing on Tests

```bash
# Run tests locally with verbose output
npm test

# Run with coverage to see what's not covered
npm run test:coverage
```

### Codecov Upload Failing

The Codecov upload is informational and won't fail CI. If uploads fail:

- Check that `CODECOV_TOKEN` is set in repository secrets
- Verify the token hasn't expired
- Check Codecov service status
