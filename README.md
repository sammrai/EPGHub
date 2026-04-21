# EPGHub

[EPGStation](https://github.com/l3tnun/EPGStation) のモダン再実装。録画と、Plex / Jellyfin 等のメディアプレイヤー向けにファイルを整理することに特化した日本向け TV 録画システム。再生は外部プレイヤーに委任。

## Stack

- **Server** — TypeScript · Hono + zod-openapi · Drizzle (PostgreSQL) · pg-boss
- **Client** — TypeScript · React + Vite (型は OpenAPI から生成)
- **Integrations** — Mirakurun · TheTVDB v4

## Quickstart

```sh
docker compose up -d
```

UI http://localhost:8889 · API docs http://localhost:8889/docs
（ポートは EPGStation の 8888 系から +1。直接 API を叩く場合は http://localhost:8890）
