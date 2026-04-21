# EPGHub

## 概要

[EPGStation](https://github.com/l3tnun/EPGStation) をベースに、モダンな API とフロントエンドで書き直した日本向け TV 録画システム。録画に特化 (視聴機能は持たない)、TVDB 連携によるシリーズ/映画の自動紐付けとファイル名正規化を追加。

## 技術スタック

- **Server**: TypeScript / Hono + @hono/zod-openapi (スキーマ駆動 OpenAPI), Drizzle (PostgreSQL), pg-boss (ジョブキュー)
- **Client**: TypeScript / React 18 + Vite (型は OpenAPI から自動生成)
- **外部連携**: Mirakurun (チューナ), TheTVDB v4 (作品メタデータ)

## クイックスタート

```sh
docker compose up -d
```

- UI: http://localhost:5173
- API docs: http://localhost:3000/docs
