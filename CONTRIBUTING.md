# Contributing

## Development

- **Branch naming:** `feat/short-description`, `fix/short-description`, `docs/short-description`
- **Commit format:** `type: concise description` (e.g., `feat: add fund-wallet admin endpoint`)
- **PRs:** Link to the issue, describe the change, paste before/after test output

## Running locally

```bash
# Install dependencies
npm install

# Copy and configure env
cp .env.example .env.local

# Run migrations
npm run db:migrate

# Start API with inline workers
npm run dev
```

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run src/tests/admin.test.ts

# Run against live testnet
npx tsx src/scripts/acceptance-smoke.ts
```

## Code style

- TypeScript strict mode
- No `any` unless absolutely necessary
- Drizzle ORM for all DB queries (no raw SQL)
- Every route handler has an OpenAPI schema
- Every new endpoint has at least 2 tests
