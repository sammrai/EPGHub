# epghub

EPGStation をベースに、録画特化・TVDB 連携を備えた日本の TV 録画システム。

## 構成

```
epghub/
├─ server/       # Hono + zod-openapi の API
├─ app/          # React + Vite のフロント
└─ EPGStation/   # 参照: 既存実装
```

- server が唯一のバックエンド窓口。`/openapi.json` と `openapi.yaml` を自動生成
- app は server の OpenAPI から型を生成して使用

## クイックスタート

```sh
docker compose up -d
```

- UI: http://localhost:5173
- API docs: http://localhost:3000/docs

## 方針

- **視聴機能は実装しない**。録画特化
- **TVDB 連携**: シリーズ/映画の紐付けと、紐付けが取れた場合のファイル名正規化
