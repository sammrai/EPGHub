# EPGHub

## 概要

[EPGStation](https://github.com/l3tnun/EPGStation) をベースに、モダンな API とフロントエンドで書き直した日本向け TV 録画システム。**録画と、録画ファイルを Plex などのメディアプレイヤーで視聴するために整理することに特化**。視聴 (ストリーミング再生) は EPGHub 自身では行わず、TVDB 連携でシリーズ/映画を自動紐付けし、Plex が解釈できる命名規則でファイル出力する。

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
