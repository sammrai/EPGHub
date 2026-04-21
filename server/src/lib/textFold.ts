import { sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';

// 検索用の正規化。ひらがなとカタカナを区別せず曖昧マッチさせるために、
// 両者を片方 (ここではカタカナ) に寄せ、全角英数字も半角に寄せる。
// 濁点/半濁点・長音符は元の位置を保つ。

// Hiragana U+3041..U+3096  ↔  Katakana U+30A1..U+30F6  (+0x60 シフトで 1:1 対応)
// 3094 "ゔ" ↔ 30F4 "ヴ" も同じ規則で揃う。3097/3098 は未使用コードポイント。
const HIRAGANA_FROM = buildRange(0x3041, 0x3096);
const KATAKANA_TO   = buildRange(0x30A1, 0x30F6);

// Full-width ASCII (U+FF01..FF5E) → ASCII。日本語配列で入力された "ＮＨＫ" を
// "NHK" と等価に検索したい。U+3000 の全角空白は ILIKE の % と干渉しないよう
// スペースに寄せる。
const FULLWIDTH_FROM = '\u3000' + buildRange(0xFF01, 0xFF5E);
const FULLWIDTH_TO   = ' '     + buildRange(0x0021, 0x007E);

// 長音の揺れ (「コンピュータ」 vs 「コンピューター」) は今回はハンドルしない。
// 発生頻度が低く、消すと別語 ("カー" vs "カ") を誤マッチさせる副作用があるので保留。

function buildRange(startCp: number, endCp: number): string {
  let out = '';
  for (let cp = startCp; cp <= endCp; cp++) out += String.fromCodePoint(cp);
  return out;
}

/** JS 側の正規化 — ユーザ入力クエリに掛ける。DB 側と同じ規則。 */
export function kanaFold(s: string): string {
  // 手書きの 2 段 translate。内側で hira→kata、外側で全角→半角。
  // 大文字小文字は ILIKE が面倒を見るのでここでは触らない。
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x3041 && cp <= 0x3096) {
      out += String.fromCodePoint(cp + 0x60);
    } else if (cp >= 0xFF01 && cp <= 0xFF5E) {
      out += String.fromCodePoint(cp - 0xFEE0);
    } else if (cp === 0x3000) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Postgres 側で同じ正規化を掛けた SQL 式を返す。 */
export function kanaFoldSql(col: SQLWrapper | SQL): SQL {
  // translate(translate(col, HIRA, KATA), FULL_ASCII, HALF_ASCII)
  // パラメータは Postgres の text リテラルとして束縛されるので、
  // 長い Unicode 文字列でも安全。
  return sql`translate(translate(${col}, ${HIRAGANA_FROM}, ${KATAKANA_TO}), ${FULLWIDTH_FROM}, ${FULLWIDTH_TO})`;
}
