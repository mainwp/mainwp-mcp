# Test Fixtures

This directory contains mock data for testing.

## Purpose

These JSON fixtures provide reusable test data that can be shared across tests. They serve two purposes:

1. **Schema validation** - Ensure fixture files remain valid as schemas evolve
2. **Integration tests** - Simulate API responses without a live MainWP Dashboard

## Structure

- `abilities.json` - Sample abilities array matching the `/wp-abilities/v1/abilities` response format
- `categories.json` - Sample categories matching the `/wp-abilities/v1/categories` response format
- `config.json` - Sample settings file for testing configuration loading
- `site.json` - Sample site data matching the `mainwp/get-site-v1` response format

## Usage

Import fixtures in test files:

```typescript
import configFixture from '../tests/fixtures/config.json';
import siteFixture from '../tests/fixtures/site.json';
```

**Current usage:**

- `src/config.test.ts` - Imports `config.json` and `site.json` to validate fixture schema compatibility

**Note:** Unit tests often use inline mocks for specific test scenarios (e.g., testing validation errors with intentionally malformed data). Fixtures are best for testing "happy path" scenarios or shared data across multiple tests.

## Maintenance

Update these fixtures when:

- API response schemas change
- New fields are added to abilities or categories
- Test scenarios require additional mock data

Keep fixtures minimal but representative of real-world responses.
