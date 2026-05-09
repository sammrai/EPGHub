# EPGHub

[EPGStation](https://github.com/l3tnun/EPGStation) をモダンに作り直した、日本向けの TV 録画システムです。録画した番組を Plex / Jellyfin などのメディアプレイヤーで扱いやすい形に整理することに特化しており、再生機能自体は持たず外部プレイヤーに委ねます。

サンプル UI は [こちら](https://sammrai.github.io/EPGHub/) で確認できます。

## Stack

- **Server** — TypeScript · Hono + zod-openapi · Drizzle (PostgreSQL) · pg-boss
- **Client** — TypeScript · React + Vite (型は OpenAPI から生成)
- **Integrations** — Mirakurun · TheTVDB v4

## Quickstart

```sh
docker compose up -d
```

UI http://localhost:8890 · API docs http://localhost:8890/docs
