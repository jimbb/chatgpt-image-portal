# ChatGPT Image Portal

Self-hosted image generation and editing portal with a browser workspace, an OpenAI-compatible API, account pools, external image providers, image history, reference sets, grid crops, masks, retries, and a managed gallery.

This is an independently maintained source fork of [jiawen-afk/chatgpt2api](https://github.com/jiawen-afk/chatgpt2api), derived from [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api). It is not affiliated with OpenAI. Some integrations use unofficial endpoints that can change without notice. Use only accounts and content you are authorized to use and follow applicable service terms.

## Quick start

Requirements: Docker Engine and Docker Compose v2.

```sh
git clone https://github.com/OWNER/REPOSITORY.git
cd chatgpt-image-portal
cp config.example.json config.json
cp .env.example .env
docker compose up -d --build
```

In PowerShell, use `Copy-Item config.example.json config.json` and
`Copy-Item .env.example .env`. Set a long random `CHATGPT2API_AUTH_KEY` in
`.env`; never use an example value. Open `http://localhost:3000`. The default
compose binds to localhost and builds this source tree. API requests use
`Authorization: Bearer YOUR_PORTAL_KEY` at `http://localhost:3000/v1`.

See [deployment](docs/deployment.md), [features](docs/features.md), and the
[API reference](docs/api.md).

## Development

Requires Python 3.13+, [uv](https://docs.astral.sh/uv/), Node.js 22+, and Bun.

```sh
cp config.example.json config.json
uv sync --frozen
uv run main.py
```

In another terminal:

```sh
cd web
bun install --frozen-lockfile
bun run dev
```

The backend listens on `127.0.0.1:8000`. Build production web files with
`bun run build`.

## Checks

```sh
uv sync --frozen
uv run python scripts/run_unit_tests.py
node --test web/test/*.cjs
cd web && bun run build && bunx tsc --noEmit
```

The selected Python suite is offline and excludes manual scripts that call a
running portal or external services. Passing it does not prove login, quota, or
real image generation.

## Privacy and security

The repository contains sanitized source and examples only. `config.json`,
`.env`, `data/`, databases, exports, build output, credentials, account data,
personal prompts, images, and local Git history are excluded. Logs and task
records can contain prompts, account identifiers, and upstream errors. Admin
exports contain credentials. Read [SECURITY.md](SECURITY.md) and
[docs/privacy.md](docs/privacy.md) before deployment.

## Layout

- `api/`: FastAPI routers
- `services/`: accounts, providers, tasks, proxy, storage, and backups
- `web/`: Next.js application
- `test/`: unit and manual integration tests
- `docs/`: deployment, API, feature, privacy, and fork notes

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). License: [MIT](LICENSE).
