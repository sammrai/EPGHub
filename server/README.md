# epghub/server

録画管理 API サーバ。**Hono + @hono/zod-openapi** によるスキーマ駆動設計。

- zod でリクエスト/レスポンスを定義 → TS 型 / ランタイム validation / OpenAPI を一本化
- `/openapi.json` と `/docs` (Scalar API Reference) を配信
- `npm run gen:openapi` で `openapi.yaml` をリポジトリにコミット可能な成果物として出力
- 録画ロジックは `../EPGStation/` 由来のコアを取り込む (予約競合検知・番組延長対応などを再利用)

## 開発

```sh
npm install
npm run dev          # http://localhost:3000
npm run gen:openapi  # openapi.yaml を更新
npm run typecheck
```

## 構成

```
server/
├─ src/
│  ├─ index.ts             # エントリ (serve)
│  ├─ app.ts               # OpenAPIHono 組み立て + /openapi.json + /docs
│  ├─ routes/              # ルート定義 (createRoute + app.openapi)
│  │  └─ channels.ts
│  ├─ schemas/             # zod スキーマ (共通 Error, Channel, ...)
│  └─ services/            # ドメインロジック アダプタ (録画コアへの接続点)
├─ fixtures/               # dev 専用サンプルデータ (src/ には入れない)
├─ scripts/
│  └─ generate-openapi.ts  # openapi.yaml 出力
├─ openapi.yaml            # 生成物 (コミット対象)
└─ tsconfig.json
```

## ルート追加の流れ

1. `src/schemas/<resource>.ts` に zod スキーマを作る（`.openapi(...)` でドキュメント付与）
2. `src/routes/<resource>.ts` に `OpenAPIHono` + `createRoute` でルートを書く
3. `src/app.ts` で `app.route('/', <router>)` にマウント
4. `npm run gen:openapi` で `openapi.yaml` を更新 → フロント側で `npm run gen:api`

## 未実装

- `/schedule`, `/reserves`, `/rules`, `/recorded`, `/tuners` 等の主要リソース
- 録画コアの抽出（EPGStation からのビジネスロジック import）
- TVDB 検索/紐付けエンドポイント
- 永続化層（DB スキーマ再設計、マイグレーション）
- 認証・権限制御
