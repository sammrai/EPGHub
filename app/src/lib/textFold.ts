// Search-time text fold — ブラウザ側で server の lib/textFold.ts と揃える。
// ひらがな → カタカナ、全角英数 → 半角。ハイライトやスニペット抽出で
// クエリと本文を同じ規則に正規化するためだけに使う。

export function kanaFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x3041 && cp <= 0x3096) {
      out += String.fromCodePoint(cp + 0x60); // ひらがな → カタカナ
    } else if (cp >= 0xFF01 && cp <= 0xFF5E) {
      out += String.fromCodePoint(cp - 0xFEE0); // 全角 ASCII → 半角
    } else if (cp === 0x3000) {
      out += ' '; // 全角空白
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * kanaFold + lowercase 適用後に `text` の中で `query` が最初に現れる位置 (およびその長さ)
 * を返す。折り畳みは 1 コードポイントを 1 コードポイントに置換するだけなので、
 * インデックスは元テキストにそのまま使える。未ヒット時は null。
 */
export function findFoldedIndex(text: string, query: string): { start: number; length: number } | null {
  const q = kanaFold(query).toLowerCase();
  if (q.length === 0) return null;
  const folded = kanaFold(text).toLowerCase();
  const hit = folded.indexOf(q);
  if (hit === -1) return null;
  return { start: hit, length: q.length };
}
