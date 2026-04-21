# epghub

EPGStation をベースに、録画特化・TVDB 連携・モダンな API を備えた日本の TV 録画システム。

## 構成

```
epghub/
├─ server/       # Hono + zod-openapi で書くスキーマ駆動 API
├─ app/          # React + Vite のフロント (視聴機能なし、録画特化)
└─ EPGStation/   # 参照: 既存実装。録画ロジックを段階的に server/ に取り込む
```

- **server** が唯一のバックエンド窓口。`/openapi.json` と `openapi.yaml` を自動生成
- **app** は server の OpenAPI から型を生成して使用
- EPGStation は移行元リファレンス。録画コア (予約競合、番組延長対応等) をサーバ側に取り込み、視聴系モジュールは落とす

## クイックスタート

### ホストマシン

```sh
# 1) Postgres
docker compose up -d

# 2) API サーバ
cd server && cp .env.example .env && npm install
npm run db:migrate
npm run dev            # http://localhost:3000  /openapi.json  /docs

# 3) フロント
cd ../app && npm install && npm run gen:api && npm run dev
# → http://localhost:5173
```

### devcontainer 内

Postgres はコンテナ内に直接インストールされ `.devcontainer/postCreate.sh` が初期化します。再度手動で立ち上げる場合:

```sh
sudo -n service postgresql start
cd server && npm run dev     # :3000
cd ../app && npm run dev     # :5173
```

### 主なコマンド

```sh
# server/
npm run dev              # Hono API (tsx watch)
npm run gen:openapi      # openapi.yaml 書き出し
npm run db:generate      # drizzle マイグレーション生成
npm run db:migrate       # 適用
npm run db:studio        # Drizzle Studio

# app/
npm run dev              # Vite
npm run gen:api          # openapi.yaml → TS 型
```

## 方針

- **視聴機能は実装しない**。録画特化
- **TVDB 連携**: シリーズ/映画の紐付けと、紐付けが取れた場合のファイル名正規化
- **スキーマ駆動**: zod → TS 型 → ランタイム validation → OpenAPI を 1 ソースで管理
- **レガシー DB 構造や API 形状は積極的に作り替えてよい**（EPGStation は出発点であり、不変の依存ではない）
