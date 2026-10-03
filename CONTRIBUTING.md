# Contributing

Keep changes focused and preserve existing API and storage formats.

Run `uv sync --frozen`, `uv run python scripts/run_unit_tests.py`,
`node --test web/test/*.cjs`, and `cd web; bun run build; bunx tsc --noEmit`
as relevant. The selected Python suite excludes live integration scripts. Use
authorized test accounts only for intentional live checks. Never attach
credentials, account exports, cookies, private screenshots, task databases, or
sensitive logs.

Describe behavior, validation, configuration changes, and upstream assumptions
in pull requests.
