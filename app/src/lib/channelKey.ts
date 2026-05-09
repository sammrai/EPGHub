// 放送局チャンネル ID から「ソース由来のプレフィクス」を剥がして数値部
// (サービス ID) を返す。同じ放送局が `svc-3272202064` (Mirakurun 由来)
// と `m3u-3272202064` (M3U 由来) のように複数 ID で重複登録されており、
// 視聴者の体験としては同一局なので、UI 上の比較ではこの正規化キーで
// 突き合わせる。
//
// プレフィクスを持たない id (将来増えうる別ソース、テスト用フィクス
// チャ等) はそのまま返す。
export function channelKey(channelId: string): string {
  return channelId.replace(/^(?:svc|m3u)-/, '');
}

export function sameChannelKey(a: string, b: string): boolean {
  return channelKey(a) === channelKey(b);
}
