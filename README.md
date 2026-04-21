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

UI http://localhost:5173 · API docs http://localhost:3000/docs
