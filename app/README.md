# epghub/app (React フロントエンド)

スキーマ駆動の epghub API サーバ (`../server/`) を叩く React + Vite クライアント。録画特化・TVDB 連携・視聴機能なしの UX。

## 構成方針

- **API**: `../server/` (Hono + zod-openapi) が唯一の接続先。視聴系ルートは持たない。
- **型**: `npm run gen:api` で `../server/openapi.yaml` → `src/api/epghub.gen.ts` を生成。
- **録画コア**: サーバが提供する REST API をラップして呼ぶ。フロントは直接録画処理を持たない。
- **TVDB**: サーバ側の別レイヤ。フロントはサーバ経由で結果を消費。

```
app/
├─ index.html
├─ vite.config.ts      # /api を server (localhost:3000) にプロキシ
├─ tsconfig.json
├─ package.json
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ api/             # epghub API クライアント
│  │  └─ epghub.ts
│  ├─ data/            # 型とストア（実データはAPI経由）
│  │  ├─ types.ts
│  │  ├─ channels.ts
│  │  └─ channelStore.ts
│  ├─ lib/epg.ts       # EPG 計算ユーティリティ
│  ├─ components/Icon.tsx
│  └─ styles/app.css   # プロトタイプ由来
└─ fixtures/           # dev 専用サンプルデータ（本番ビルドに載せない）
   ├─ channels.ts
   ├─ programs.ts
   └─ tvdb.ts
```

## 開発

```sh
# 1) サーバ起動 (別ターミナル)
cd ../server && npm install && npm run dev
# → http://localhost:3000 で起動, /openapi.json /docs も公開

# 2) OpenAPI 型生成 (openapi.yaml は server 側で出力)
cd ../server && npm run gen:openapi
cd ../app    && npm install && npm run gen:api

# 3) フロント起動
npm run dev
# → http://localhost:5173  (/api/* → :3000 にプロキシ)
```

## 既知の残タスク

- プロトタイプの Shell/Grid/Timeline/Agenda/Modal/Pages の React 移植
- 放送局設定画面（チューナータブ）の実装
- 予約競合/重複警告の UI 表示
- TVDB 検索 UI（紐付け候補の表示）
