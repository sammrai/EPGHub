// Tests for findEpisodeForProgram — the per-program S/E resolver used
// by the auto-matcher. Pure logic, no DB. Run:
//
//   node --import tsx --test src/services/findEpisodeForProgram.test.ts
//
// Resolution order locked here:
//   1. Quoted subtitle in EPG title === TVDB episode name (series-unique
//      → pins season directly). Real seasons (s≥1) preferred over s=0.
//   2. Direct #N match (latest season wins on ties)
//   3. Cumulative #N fallback (broadcaster numbers across seasons —
//      ダンダダン #18 = S1 12話 + S2 6話 で第18話扱い)
//   4. TVDB aired-date match against JST broadcast day
import 'dotenv/config';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { findEpisodeForProgram } from './matchService.ts';

type Episode = { s: number; e: number; aired?: string; name?: string };

// Build a contiguous episode list — 1..count for the given season.
function eps(s: number, count: number, namePrefix?: string): Episode[] {
  return Array.from({ length: count }, (_, i) => ({
    s,
    e: i + 1,
    name: namePrefix ? `${namePrefix} ${i + 1}` : undefined,
  }));
}

const SOME_START = '2026-05-09T18:38:00.000Z';

describe('findEpisodeForProgram — quoted subtitle', () => {
  test('subtitle pins older season even when same #N exists in newer season', () => {
    // 青春ブタ野郎 第6話「君が選んだこの世界」 is a rerun of S1E6.
    // S2 also has an E6 with a different name. The subtitle in the
    // title is series-unique, so it pins S1 without needing tiebreakers.
    const list: Episode[] = [
      { s: 0, e: 6, name: '青春ブタ野郎はゆめみる少女の夢を見ない' },
      { s: 1, e: 6, name: '君が選んだこの世界', aired: '2018-11-08' },
      { s: 2, e: 6, name: '記憶領域の君と僕', aired: '2025-08-09' },
    ];
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      '青春ブタ野郎はバニーガール先輩の夢を見ない　第６話「君が選んだこの世界」',
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: '君が選んだこの世界' });
  });

  test('subtitle alone (no #N) is enough to identify the episode', () => {
    const list: Episode[] = [
      { s: 1, e: 3, name: '副題A' },
      { s: 1, e: 4, name: '副題B' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル「副題B」');
    assert.deepEqual(hit, { s: 1, e: 4, name: '副題B' });
  });

  test('zenkaku/hankaku and whitespace differences do not block name match', () => {
    const list: Episode[] = [
      { s: 1, e: 5, name: 'EP NAME 5！' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'X「ＥＰ　ＮＡＭＥ５！」');
    assert.deepEqual(hit, { s: 1, e: 5, name: 'EP NAME 5！' });
  });

  test('subtitle that matches no episode → falls through to #N logic', () => {
    // The 「副題」 doesn't appear in any episode name, so name-match
    // abstains and the #N path picks S2 (highest season tiebreak).
    const list: Episode[] = [
      ...eps(1, 6, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル 第5話「未知の副題」');
    assert.deepEqual(hit, { s: 2, e: 5, name: 'S2 5' });
  });

  test('quotes in title that are show-name fragments (no episode-name hit) are ignored', () => {
    // The title contains 「...」 but it doesn't match any TVDB name —
    // the function must fall through cleanly, not crash or pick wrong.
    const list: Episode[] = [
      { s: 1, e: 3, name: 'real name' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '「show host」 #3');
    assert.deepEqual(hit, { s: 1, e: 3, name: 'real name' });
  });

  test('name collision in S0 specials is deprioritised vs real season', () => {
    // Both s=0 and s=1 carry the same name (rare but possible);
    // the real-season hit should win.
    const list: Episode[] = [
      { s: 0, e: 1, name: '同名特番' },
      { s: 1, e: 4, name: '同名特番' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル「同名特番」');
    assert.deepEqual(hit, { s: 1, e: 4, name: '同名特番' });
  });
});

describe('findEpisodeForProgram — direct #N', () => {
  test('#3 with single-season list → S1E3', () => {
    const list = eps(1, 12);
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #3');
    assert.deepEqual(hit, { s: 1, e: 3, name: undefined });
  });

  test('zenkaku ＃１２ → S1E12', () => {
    const list = eps(1, 12);
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル　＃１２');
    assert.deepEqual(hit, { s: 1, e: 12, name: undefined });
  });

  test('NHK 朝ドラ format `（NN）` parses as ep number', () => {
    // 連続テレビ小説 `風、薫る（３１）第７週「届かぬ声」` — daily ep 31.
    const list = eps(1, 35);
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      '【連続テレビ小説】風、薫る（３１）第７週「届かぬ声」[解][字]',
    );
    assert.deepEqual(hit, { s: 1, e: 31, name: undefined });
  });

  test('hankaku year-tag `(2025)` does NOT parse as ep number', () => {
    // Only zenkaku parens are NHK-style daily-ep markers; hankaku
    // parens often carry year/runtime metadata — must not pollute.
    const list: Episode[] = [
      { s: 1, e: 7, aired: '2026-05-09', name: 'aired hit' },
    ];
    // jstBroadcastDay(SOME_START) is 2026-05-09; without a parsed ep
    // number the function falls through to aired-day match.
    const hit = findEpisodeForProgram(list, SOME_START, 'Show (2025) reissue');
    assert.deepEqual(hit, { s: 1, e: 7, name: 'aired hit' });
  });

  test('multi-season + collision → highest season wins', () => {
    // Both S1 and S2 have an E5; the matcher picks S2 (the latest).
    const list: Episode[] = [
      ...eps(1, 6, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #5');
    assert.deepEqual(hit, { s: 2, e: 5, name: 'S2 5' });
  });

  test('multi-season + collision + [再] → LOWEST season wins (rerun)', () => {
    // Same setup but the title carries `[再]`. A rerun is a replay of an
    // older season, so the matcher must flip the tiebreaker and pick S1.
    const list: Episode[] = [
      ...eps(1, 6, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #5[再]');
    assert.deepEqual(hit, { s: 1, e: 5, name: 'S1 5' });
  });

  test('zenkaku ［再］ also flips the tiebreaker', () => {
    const list: Episode[] = [
      ...eps(1, 6, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #5［再］');
    assert.deepEqual(hit, { s: 1, e: 5, name: 'S1 5' });
  });
});

describe('findEpisodeForProgram — 風、薫る regression cases', () => {
  // tvdb_id=459337 風、薫る (NHK 連続テレビ小説). The daily airings carry
  // 連続テレビ小説 standard format `（NN）第N週「副題」`, with weekly digests
  // separately listed in TVDB s=0 as `土曜ダイジェスト版 第N週`. These two
  // cases exercise both the digest non-match path and the daily-ep parens.
  const NIKAOI_EPISODES: Episode[] = [
    { s: 0, e: 2, name: '土曜ダイジェスト版 第1週', aired: '2026-04-04' },
    { s: 0, e: 3, name: '土曜ダイジェスト版 第2週', aired: '2026-04-11' },
    { s: 0, e: 4, name: '土曜ダイジェスト版 第3週', aired: '2026-04-18' },
    ...Array.from({ length: 35 }, (_, i) => ({
      s: 1,
      e: i + 1,
      name: `第${Math.ceil((i + 1) / 5)}週「subtitle」(${i + 1})`,
    })),
  ];

  test('digest 第6週 with no quoted subtitle and no cached week → null (no spurious S1E2)', () => {
    // Case 1: svc-3211240960_2026-05-10T19:45:00.000Z. The week-6 digest
    // isn't in the cache (only weeks 1-3 cached). No #N, no 「...」 → must
    // resolve to null instead of being yanked into a daily S1 slot.
    const hit = findEpisodeForProgram(
      NIKAOI_EPISODES,
      '2026-05-10T19:45:00.000Z',
      '【連続テレビ小説】風、薫る　土曜ダイジェスト版　第６週[字][再]',
    );
    assert.equal(hit, null);
  });

  test('daily ep `（３１）` with stale cache (only E1..E20) → null', () => {
    // Case 2 as it stands today: TVDB cache only has E1..E20, broadcast
    // is at E31. parenM extracts 31, but no candidate matches; the
    // cumulative fallback also bails (maxE=20 < 31). Stays null until
    // the cache catches up.
    const stale = NIKAOI_EPISODES.filter((ep) => ep.s === 0 || ep.e <= 20);
    const hit = findEpisodeForProgram(
      stale,
      '2026-05-10T22:30:00.000Z',
      '【連続テレビ小説】風、薫る（３１）第７週「届かぬ声」[解][字]',
    );
    assert.equal(hit, null);
  });

  test('daily ep `（３１）` with full cache → S1E31', () => {
    // Same EPG title, but with the cache extended to cover E31 — parens
    // parsing pins it to S1E31 directly.
    const hit = findEpisodeForProgram(
      NIKAOI_EPISODES,
      '2026-05-10T22:30:00.000Z',
      '【連続テレビ小説】風、薫る（３１）第７週「届かぬ声」[解][字]',
    );
    assert.deepEqual(hit, {
      s: 1,
      e: 31,
      name: '第7週「subtitle」(31)',
    });
  });
});

describe('findEpisodeForProgram — ダンダダン regression case', () => {
  // tvdb_id=432832 ダンダダン. Broadcaster numbers continuously across
  // seasons (S1=12 eps + S2=12 eps; #18 = S2E6). The EPG title carries
  // both the cumulative number and the episode subtitle, so two
  // independent paths (quoted-name + cumulative-N) should agree on S2E6.
  const DANDADAN_EPISODES: Episode[] = [
    { s: 1, e: 1, name: 'それって恋のはじまりじゃんよ', aired: '2024-10-04' },
    { s: 1, e: 2, name: 'それって宇宙人じゃね', aired: '2024-10-11' },
    { s: 1, e: 3, name: 'ババアとババアが激突じゃんか', aired: '2024-10-18' },
    { s: 1, e: 4, name: 'ターボババアをぶっ飛ばそう', aired: '2024-10-25' },
    { s: 1, e: 5, name: 'タマはどこじゃんよ', aired: '2024-11-01' },
    { s: 1, e: 6, name: 'ヤベー女がきた', aired: '2024-11-08' },
    { s: 1, e: 7, name: '優しい世界へ', aired: '2024-11-15' },
    { s: 1, e: 8, name: 'なんかモヤモヤするじゃんよ', aired: '2024-11-22' },
    { s: 1, e: 9, name: '合体！ セルポドーバーデーモンネッシー！', aired: '2024-11-29' },
    { s: 1, e: 10, name: 'キャトルミューティレーションを君は見たか', aired: '2024-12-06' },
    { s: 1, e: 11, name: '初恋の人', aired: '2024-12-13' },
    { s: 1, e: 12, name: '呪いの家へレッツゴー', aired: '2024-12-20' },
    { s: 2, e: 1, name: '大蛇伝説ってこれじゃんよ', aired: '2025-07-04' },
    { s: 2, e: 2, name: '邪視', aired: '2025-07-11' },
    { s: 2, e: 3, name: 'ゆるさねえぜ', aired: '2025-07-18' },
    { s: 2, e: 4, name: 'やば過ぎじゃんよ', aired: '2025-07-25' },
    { s: 2, e: 5, name: 'みんなでお泊まりじゃんよ', aired: '2025-08-01' },
    { s: 2, e: 6, name: '家族になりました', aired: '2025-08-08' },
    { s: 2, e: 7, name: 'なんかモヤモヤするじゃんよ', aired: '2025-08-15' },
    { s: 2, e: 8, name: 'がんばれオカルン', aired: '2025-08-22' },
    { s: 2, e: 9, name: '家を建て直したい', aired: '2025-08-29' },
    { s: 2, e: 10, name: 'モテる秘訣はなんだ', aired: '2025-09-05' },
    { s: 2, e: 11, name: '怪獣じゃんよ', aired: '2025-09-12' },
    { s: 2, e: 12, name: '激突！　宇宙怪獣対巨大ロボ！', aired: '2025-09-19' },
  ];

  test('ダンダダン ＃１８「家族になりました」 → S2E6 via subtitle', () => {
    // svc-3272202064_2026-05-09T18:38:00.000Z. The quoted subtitle
    // `「家族になりました」` is series-unique — name-match pins S2E6
    // directly, without needing the cumulative (#18 = S1.12 + S2.6) path.
    const hit = findEpisodeForProgram(
      DANDADAN_EPISODES,
      '2026-05-09T18:38:00.000Z',
      'ダンダダン　＃１８[再]「家族になりました」',
    );
    assert.deepEqual(hit, { s: 2, e: 6, name: '家族になりました' });
  });

  test('ダンダダン ＃１８ alone (no subtitle) → S2E6 via cumulative', () => {
    // Same series, but without the quoted subtitle in the title — the
    // cumulative-N fallback must still produce S2E6.
    const hit = findEpisodeForProgram(
      DANDADAN_EPISODES,
      '2026-05-09T18:38:00.000Z',
      'ダンダダン　＃１８[再]',
    );
    assert.deepEqual(hit, { s: 2, e: 6, name: '家族になりました' });
  });

  test('ダンダダン ＃１９ with name shared across S1E8/S2E7 → cumulative wins (S2E7)', () => {
    // svc-3272202064_2026-05-16T18:38:00.000Z. The subtitle
    // 「なんかモヤモヤするじゃんよ」 appears as the name of BOTH S1E8 and
    // S2E7, so name match is ambiguous and step 1 must abstain. The
    // cumulative-#N fallback (#19 = 12 + 7 → S2E7) then produces the
    // correct answer. This locks in: name match abstains on collision
    // rather than picking the lower season by enumeration order.
    const hit = findEpisodeForProgram(
      DANDADAN_EPISODES,
      '2026-05-16T18:38:00.000Z',
      'ダンダダン　＃１９[再]「なんかモヤモヤするじゃんよ」',
      ['ダンダダン'],
    );
    assert.deepEqual(hit, { s: 2, e: 7, name: 'なんかモヤモヤするじゃんよ' });
  });
});

describe('findEpisodeForProgram — 黄泉のツガイ regression cases', () => {
  // tvdb_id=452711 黄泉のツガイ. Currently airing series; later episodes
  // are cached as `name: 'TBA'` (TVDB hasn't filled them in yet). These
  // exercise the zenkaku `＃NN` + quoted-name path and the kanji-digit
  // `第七話` path independently.
  const YOMITSU_EPISODES: Episode[] = [
    { s: 1, e: 1, name: 'アサとユル', aired: '2026-04-04' },
    { s: 1, e: 2, name: '右と左', aired: '2026-04-11' },
    { s: 1, e: 3, name: 'デラとハナ', aired: '2026-04-18' },
    { s: 1, e: 4, name: 'ジンとユル', aired: '2026-04-25' },
    { s: 1, e: 5, name: '兎と亀', aired: '2026-05-02' },
    { s: 1, e: 6, name: '影森家と謎の襲撃者', aired: '2026-05-09' },
    { s: 1, e: 7, name: 'TBA', aired: '2026-05-16' },
    { s: 1, e: 8, name: 'TBA', aired: '2026-05-23' },
  ];

  test('zenkaku ＃０６ + quoted name → S1E6 via subtitle path', () => {
    // svc-3272202064_2026-05-09T17:08:00.000Z. Both signals (`＃０６`
    // and 「影森家と謎の襲撃者」) point at S1E6; the subtitle-name path
    // wins first because it's the strongest. Locks in zenkaku-paren
    // digit normalisation in normalizeEpisodeName too.
    const hit = findEpisodeForProgram(
      YOMITSU_EPISODES,
      '2026-05-09T17:08:00.000Z',
      '黄泉のツガイ　＃０６「影森家と謎の襲撃者」',
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: '影森家と謎の襲撃者' });
  });

  test('kanji-digit 第七話 → S1E7 via parseTitleEpisodeNumber kanji path', () => {
    // svc-400211_2026-05-16T14:30:00.000Z. Title has no quoted subtitle
    // and uses kanji digits ("七"=7). Pins S1E7 even though TVDB still
    // shows the episode name as 'TBA'.
    const hit = findEpisodeForProgram(
      YOMITSU_EPISODES,
      '2026-05-16T14:30:00.000Z',
      '黄泉のツガイ　第七話',
    );
    assert.deepEqual(hit, { s: 1, e: 7, name: 'TBA' });
  });
});

describe('findEpisodeForProgram — ポツンと一軒家 stale-cache case', () => {
  // tvdb_id=369652 ポツンと一軒家. Year-as-season variety show. EPG title
  // contains a free-form synopsis (no #N, no quoted subtitle name that
  // appears in TVDB), and the broadcast date is past the latest cached
  // aired. Must resolve to null — the old rerun-pattern fallback would
  // wrongly drag this into S2019E1.
  const POTSUN_EPISODES: Episode[] = [
    { s: 2026, e: 8, name: 'にぎやか親子3世代生活！広い果樹園のびのび子育て！最高の遊び場', aired: '2026-03-22' },
    { s: 2026, e: 9, name: '春の2時間SP Uターン移住で親子2世帯山暮らし！山の恵みで豪快BBQ！', aired: '2026-03-29' },
    { s: 2026, e: 10, name: '美しい雪景色に一目惚れ！夫婦の夢叶う…野鳥の天国で古民家暮らし', aired: '2026-04-12' },
    { s: 2026, e: 11, name: '定年後自ら建築⁉元気な90歳!山の宴会場で仲間とカラオケ焼肉大会', aired: '2026-04-19' },
    // Older year-as-season buckets for realism — none should be picked.
    { s: 2019, e: 1, name: 'ある年のお話', aired: '2019-01-06' },
    { s: 2025, e: 1, name: '別年のお話', aired: '2025-01-19' },
  ];

  test('synopsis-as-subtitle doesn’t collide with cached names → null', () => {
    // svc-3272302072_2026-05-10T10:54:00.000Z. Broadcast 2026-05-10 is
    // past the latest cached aired (2026-04-19). With no #N marker and
    // no exact name match, every signal-based step must return null.
    const hit = findEpisodeForProgram(
      POTSUN_EPISODES,
      '2026-05-10T10:54:00.000Z',
      'ポツンと一軒家　夫婦二人三脚で夢追う！大自然のヤギ牧場で…感動ヤギ出産立ち会い[字]',
      ['ポツンと一軒家'],
    );
    assert.equal(hit, null);
  });
});

describe('findEpisodeForProgram — クジマ歌えば家ほろろ subtitle-derive case', () => {
  // tvdb_id=449913 クジマ歌えば家ほろろ. EPG title uses `▼` to introduce the
  // episode subtitle (no quotes, no #N). Subtitle derivation = "title −
  // show name − symbols" must produce `嘘から出た実`, which matches S1E5.
  // Locks in the fact that we don't depend on `▼` or any specific
  // delimiter — stripping the show name + structural noise is enough.
  const KUJIMA_EPISODES: Episode[] = [
    { s: 1, e: 1, name: '初めてのブリンは塊になる', aired: '2026-04-09' },
    { s: 1, e: 2, name: '鵜の真似をする烏', aired: '2026-04-16' },
    { s: 1, e: 3, name: '同じ羽根の鳥は生まれない', aired: '2026-04-23' },
    { s: 1, e: 4, name: '越鳥北枝に巣くう', aired: '2026-04-30' },
    { s: 1, e: 5, name: '嘘から出た実', aired: '2026-05-07' },
    { s: 1, e: 6, name: 'TBA', aired: '2026-05-14' },
  ];

  test('▼-introduced subtitle is derived and matches S1E5', () => {
    // m3u-400161_2026-05-12T23:30:00+09:00. Title:
    // `クジマ歌えば家ほろろ▼嘘から出た実` — no `「」` quote and no #N.
    // With show titles supplied, the subtitle derivation strips the
    // show name and `▼`, leaving `嘘から出た実` for name match.
    const hit = findEpisodeForProgram(
      KUJIMA_EPISODES,
      '2026-05-12T14:30:00.000Z',
      'クジマ歌えば家ほろろ▼嘘から出た実',
      ['クジマ歌えば家ほろろ'],
    );
    assert.deepEqual(hit, { s: 1, e: 5, name: '嘘から出た実' });
  });

  test('without showTitles param, falls back to quoted-segment scan and misses', () => {
    // Same input but without the optional showTitles arg — the function
    // can only scan `「」`/`『』` segments, and there are none, so the
    // signal-based steps all miss. This documents the contract: the
    // derivation needs the show name to operate.
    const hit = findEpisodeForProgram(
      KUJIMA_EPISODES,
      '2026-05-12T14:30:00.000Z',
      'クジマ歌えば家ほろろ▼嘘から出た実',
    );
    assert.equal(hit, null);
  });
});

describe('findEpisodeForProgram — 春夏秋冬代行者 daiji case', () => {
  // tvdb_id=462446 春夏秋冬代行者 春の舞. Title uses 大字 (formal kanji
  // numerals): 第捌話 = "8th episode". Locks in daiji-digit support in
  // parseTitleEpisodeNumber.
  const SHIKI_EPISODES: Episode[] = [
    { s: 1, e: 1, name: '春の舞', aired: '2026-03-29' },
    { s: 1, e: 2, name: '名残雪', aired: '2026-04-05' },
    { s: 1, e: 3, name: '片影', aired: '2026-04-12' },
    { s: 1, e: 4, name: '朝凪', aired: '2026-04-19' },
    { s: 1, e: 5, name: '二人ぼっち', aired: '2026-04-26' },
    { s: 1, e: 6, name: '還る場所', aired: '2026-05-03' },
    { s: 1, e: 7, name: '宵闇', aired: '2026-05-10' },
    { s: 1, e: 8, name: 'TBA', aired: '2026-05-17' },
  ];

  test('daiji 第捌話 (= 第8話) → S1E8', () => {
    // svc-400211_2026-05-16T15:00:00.000Z. `捌` is the formal/daiji form
    // of 8 (used in legal docs and stylistically in some titles). The
    // kanji-digit parser must recognise daiji on top of standard 一二三….
    const hit = findEpisodeForProgram(
      SHIKI_EPISODES,
      '2026-05-16T15:00:00.000Z',
      '春夏秋冬代行者 春の舞　第捌話',
    );
    assert.deepEqual(hit, { s: 1, e: 8, name: 'TBA' });
  });
});

describe('findEpisodeForProgram — リィンカーネーションの花弁 thematic counter case', () => {
  // svc-400141_2026-05-10T14:00:00.000Z. tvdb_id=452801. EPG titles use
  // 「第N輪」 ("Nth ring/wheel") as a thematic per-airing episode counter
  // — same shape as 第N話/回/夜/局 but with a show-themed glyph. Locks in
  // 輪 in the kanji-digit branch of parseTitleEpisodeNumber so the cascade
  // resolves S/E instead of falling through all four steps to null.
  const HANABIRA_EPISODES: Episode[] = [
    { s: 1, e: 1, name: '花弁を散らす者達', aired: '2026-04-03' },
    { s: 1, e: 2, name: '持つ者としての在り方', aired: '2026-04-10' },
    { s: 1, e: 3, name: '開戦', aired: '2026-04-17' },
    { s: 1, e: 4, name: '全知と腐敗', aired: '2026-04-24' },
    { s: 1, e: 5, name: 'さようなら、耳を傾けてくれた人', aired: '2026-05-01' },
    { s: 1, e: 6, name: '西耶', aired: '2026-05-08' },
    { s: 1, e: 7, name: '咲き廻るリィンカーネーション', aired: '2026-05-15' },
  ];

  test('第六輪 (kanji "6th ring") → S1E6', () => {
    const hit = findEpisodeForProgram(
      HANABIRA_EPISODES,
      '2026-05-10T14:00:00.000Z',
      'アニメ\u3000リィンカーネーションの花弁\u3000第六輪',
      ['リィンカーネーションの花弁'],
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: '西耶' });
  });
});

describe('findEpisodeForProgram — メイドさんは食べるだけ thematic counter case', () => {
  // svc-400151_2026-05-10T14:00:00.000Z. EPG title carries the AT-X
  // broadcaster slot prefix `アニメA・` AND the cooking-themed thematic
  // episode counter `6食目` ("6th meal") — bare digit + 食目 with no
  // `第` prefix. Locks in 食目 in parseTitleEpisodeNumber's bare-digit
  // branch so the cascade resolves S/E instead of falling through.
  const MAID_EPISODES: Episode[] = [
    { s: 1, e: 1, name: 'パンケーキ／焼き魚／オムレツ', aired: '2026-04-05' },
    { s: 1, e: 2, name: 'ハンバーグ／生姜焼き／天ぷら', aired: '2026-04-12' },
    { s: 1, e: 3, name: 'カレー／サラダ／味噌汁', aired: '2026-04-19' },
    { s: 1, e: 4, name: 'パスタ／ピザ／ティラミス', aired: '2026-04-26' },
    { s: 1, e: 5, name: '寿司／天ざる／茶碗蒸し', aired: '2026-05-03' },
    { s: 1, e: 6, name: 'うなぎ／冷奴／お祭り', aired: '2026-05-10' },
    { s: 1, e: 7, name: 'TBA', aired: '2026-05-17' },
  ];

  test('bare 6食目 ("6th meal") → S1E6 via title-parsed episode number', () => {
    // The `アニメA・` slot prefix is stripped at normalize-time so the
    // search key resolves to the canonical show. The bare-digit `食目`
    // counter is then parsed by parseTitleEpisodeNumber's bare branch —
    // same shape as `4話` / `3回` for broadcasters that drop `第`.
    const hit = findEpisodeForProgram(
      MAID_EPISODES,
      '2026-05-10T14:00:00.000Z',
      'アニメA・メイドさんは食べるだけ\u30006食目「うなぎ／冷奴／お祭り」',
      ['メイドさんは食べるだけ'],
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: 'うなぎ／冷奴／お祭り' });
  });
});

describe('findEpisodeForProgram — あかね噺 thematic counter case', () => {
  // svc-400151_2026-05-10T16:00:00.000Z. tvdb_id=466488. EPG titles for
  // the rakugo anime あかね噺 use 「第N席」 ("Nth seat/session") as a
  // thematic per-airing episode counter — 席 is rakugo terminology for
  // a performance slot. Same shape as 第N話/回/夜/局/輪 but with a
  // show-themed glyph. Locks in 席 in the kanji-digit branch of
  // parseTitleEpisodeNumber so the cascade resolves S/E instead of
  // falling through all four steps to null.
  const AKANEBANASHI_EPISODES: Episode[] = [
    { s: 1, e: 1, name: 'あの日', aired: '2026-04-04' },
    { s: 1, e: 2, name: '初高座', aired: '2026-04-11' },
    { s: 1, e: 3, name: '兄弟子', aired: '2026-04-18' },
    { s: 1, e: 4, name: '喜びの先', aired: '2026-04-25' },
    { s: 1, e: 5, name: '進む道', aired: '2026-05-02' },
    { s: 1, e: 6, name: '寺子屋', aired: '2026-05-09' },
    { s: 1, e: 7, name: 'TBA', aired: '2026-05-16' },
  ];

  test('第六席 (kanji "6th seat") → S1E6', () => {
    const hit = findEpisodeForProgram(
      AKANEBANASHI_EPISODES,
      '2026-05-10T16:00:00.000Z',
      '[字]アニメA・あかね噺\u3000第六席「寺子屋」',
      ['あかね噺'],
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: '寺子屋' });
  });
});

describe('findEpisodeForProgram — generic 第N+kanji counter (issue #14)', () => {
  // svc-3272502088_2026-05-16T08:30:00.000Z (issue #14). 本好きの下剋上 uses
  // 「第N章」 ("Nth chapter") as a thematic per-airing episode counter — same
  // shape as 第N話/回/夜/局/輪/席 but with another show-themed glyph. Rather
  // than enumerate every glyph that broadcasters invent (`輪`, `食目`, `席`,
  // `章`, `羽`, `集`, …), the parser now accepts ANY single-kanji counter
  // generically when followed by a structural boundary (whitespace, quote
  // opener, bracket, or end-of-string), with explicit blocks for known
  // false-positive kanji (`位/戦/弾/番/号/代/国/人/本/個`) and for kanji-
  // digits (so `第一三共` doesn't read `三` as the counter). This test locks
  // in the open-class shape against future regressions.
  const HONZUKI_EPISODES: Episode[] = [
    { s: 1, e: 1, name: 'Episode 1' },
    { s: 1, e: 2, name: 'Episode 2' },
    { s: 1, e: 3, name: 'Episode 3' },
    { s: 1, e: 4, name: 'Episode 4' },
    { s: 1, e: 5, name: '演奏会の準備' },
    { s: 1, e: 6, name: 'フェシュピールコンサート' },
    { s: 1, e: 7, name: 'TBA' },
  ];

  test('第六章「フェシュピールコンサート」 → S1E6 via subtitle name match', () => {
    // Subtitle wins step 1 even before we get to title-parsed N — the new
    // strip-rules in deriveEpisodeSubtitle drop `第六章` so the candidate
    // is just `フェシュピールコンサート`, which matches the episode name.
    const hit = findEpisodeForProgram(
      HONZUKI_EPISODES,
      '2026-05-16T08:30:00.000Z',
      '本好きの下剋上\u3000領主の養女\u3000第六章「フェシュピールコンサート」[字][デ]',
      ['本好きの下剋上 領主の養女'],
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: 'フェシュピールコンサート' });
  });

  test('第六章 alone (no subtitle hit) → S1E6 via parsed episode number', () => {
    // When the subtitle doesn't match any episode name, step 2's
    // parseTitleEpisodeNumber kicks in and now accepts `第N章` generically.
    const hit = findEpisodeForProgram(
      HONZUKI_EPISODES,
      '2026-05-16T08:30:00.000Z',
      '本好きの下剋上\u3000領主の養女\u3000第六章「未知の副題」[字][デ]',
      ['本好きの下剋上 領主の養女'],
    );
    assert.equal(hit?.s, 1);
    assert.equal(hit?.e, 6);
  });

  test('第六羽 (ニワトリ・ファイター bird-counter) → S1E6 via parsed episode number', () => {
    // Same generic-counter path: `羽` is the bird counter and should fall
    // through the open-class branch to e=6.
    const list: Episode[] = [...eps(1, 7, 'S1')];
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      'アニメ\u3000ニワトリ・ファイター\u3000第六羽',
      ['ニワトリ・ファイター'],
    );
    assert.deepEqual(hit, { s: 1, e: 6, name: 'S1 6' });
  });

  test('第N部 (season selector) is NOT treated as an episode index', () => {
    // `第2部` is a season/part marker, not an episode — when the title
    // carries both `第2部` and `第1話`, the parser must skip `部` and
    // resolve to e=1.
    const list: Episode[] = [
      { s: 1, e: 1, name: 'P1E1' },
      { s: 2, e: 1, name: '帰って来た桜吹雪' },
    ];
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      '名奉行 遠山の金さん 第2部\u3000第１話\u3000「帰って来た桜吹雪」',
      ['名奉行 遠山の金さん'],
    );
    // Subtitle pins it; the underlying point is that `parseTitleEpisodeNumber`
    // also returns 1 (not 2) here.
    assert.deepEqual(hit, { s: 2, e: 1, name: '帰って来た桜吹雪' });
  });

  test('第N位 / 第N戦 / 交響曲第N番 are NOT treated as episode indices', () => {
    // Count-noun false-positives blocked by CUT_NON_COUNTER_KANJI_RE — a
    // title with no real episode marker should fall through to aired-day
    // matching, not get tricked by `第3位` etc.
    const list: Episode[] = [
      { s: 1, e: 3, aired: '2026-05-09', name: 'aired hit' },
    ];
    const cases = [
      'ランキング　第3位は驚きの一品',
      'スーパーGT第2戦3時間レース',
      '交響曲第2番「鐘」',
    ];
    for (const title of cases) {
      const hit = findEpisodeForProgram(list, SOME_START, title);
      // None of these should resolve via parseTitleEpisodeNumber. With
      // SOME_START on 2026-05-09, the aired-day fallback catches e=3.
      assert.equal(hit?.e, 3, `unexpected hit for "${title}"`);
    }
  });
});

describe('findEpisodeForProgram — 魔入りました！入間くん season-suffix case', () => {
  // svc-3272102056_2026-05-15T10:00:00.000Z (issue #13). EPG title carries
  // a bare `アニメ　` broadcaster prefix, a trailing season digit `４`
  // glued to kana `くん`, the daily-ep paren `（６）`, and a quoted
  // episode subtitle `「音楽祭、本番！！」`. The normalizer reduces the
  // title to `魔入りました!入間くん` (matches TVDB id=369144 with score
  // 1000); inside `findEpisodeForProgram` step 1's derived-subtitle
  // candidate (`アニメ ４ 音楽祭、本番！！`) doesn't hit any episode name
  // because it's contaminated by the leading `アニメ ４` residue, so step 2
  // takes over: `parseTitleEpisodeNumber`'s zenkaku-paren branch picks
  // up `（６）` → 6, and the highest-season tiebreaker among `e===6`
  // candidates lands on S4E6. Locks in that this title resolves cleanly
  // even when the show name is followed by a kana-glued season digit
  // before the paren.
  const IRUMA_EPISODES: Episode[] = [
    { s: 1, e: 6, name: '魔界の一日体験', aired: '2019-11-09' },
    { s: 4, e: 1, name: 'その先へ', aired: '2026-04-10' },
    { s: 4, e: 2, name: '音楽祭、はじまる', aired: '2026-04-17' },
    { s: 4, e: 3, name: '舞台裏', aired: '2026-04-24' },
    { s: 4, e: 4, name: 'リハーサル', aired: '2026-05-01' },
    { s: 4, e: 5, name: '前夜', aired: '2026-05-08' },
    { s: 4, e: 6, name: '音楽祭、本番！！', aired: '2026-05-15' },
    { s: 4, e: 7, name: 'TBA', aired: '2026-05-22' },
  ];

  test('アニメ　… ４（６）「音楽祭、本番！！」 → S4E6 via paren-N + latest-season tiebreaker', () => {
    const hit = findEpisodeForProgram(
      IRUMA_EPISODES,
      '2026-05-15T10:00:00.000Z',
      'アニメ\u3000魔入りました！入間くん４（６）「音楽祭、本番！！」[字]',
      ['魔入りました！入間くん'],
    );
    assert.deepEqual(hit, { s: 4, e: 6, name: '音楽祭、本番！！' });
  });
});

describe('findEpisodeForProgram — 夜桜さんちの大作戦 bare kanji-prefix counter (issue #15)', () => {
  // svc-400141_2026-05-12T15:30:00.000Z (issue #15, dup #19). EPG title carries
  // a bare `アニメ　` broadcaster prefix, a `第２期` season indicator, the
  // show-themed bare counter `作戦31` (= "Operation 31", show-internal label
  // analogous to `第N席`/`第N輪`/`N食目` but in `<kanji-prefix><digit>` shape
  // without the `第` lead), and the real episode subtitle `スパイ昇級試験`
  // (= S2E4). The subtitle deriver must:
  //   - drop the show name (`夜桜さんちの大作戦`),
  //   - drop the `第２期` season selector (handled by the existing CLOSED
  //     counter strip),
  //   - drop the bare `作戦31` thematic counter (NEW: the
  //     `<2-4 kanji><digit>+` strip, gated on whitespace boundaries on
  //     both sides so it can't eat year/length attributes like
  //     `平成30年` or `刑事110キロ`),
  //   - drop the orphaned `アニメ` broadcast prefix from the residue
  //     (NEW: BLOCK_PREFIX_RE re-applied on the cleaned candidate).
  // What's left is `スパイ昇級試験`, matching S2E4 by name.
  const YOZAKURA_EPISODES: Episode[] = [
    { s: 0, e: 1, name: 'Mini Mission: Yozakura Family (1)', aired: '2024-04-08' },
    { s: 1, e: 1, name: '桜の指輪', aired: '2024-04-07' },
    { s: 1, e: 2, name: '夜桜の命', aired: '2024-04-14' },
    { s: 1, e: 27, name: '披露宴', aired: '2024-10-06' },
    { s: 2, e: 1, name: 'アイさん夜桜家へ/ミニ凶一郎', aired: '2026-04-12' },
    { s: 2, e: 2, name: '勝ち組と負け組', aired: '2026-04-19' },
    { s: 2, e: 3, name: '辛三兄ちゃん見守り隊', aired: '2026-04-26' },
    { s: 2, e: 4, name: 'スパイ昇級試験', aired: '2026-05-03' },
    { s: 2, e: 5, name: '愛の結晶', aired: '2026-05-10' },
    { s: 2, e: 6, name: 'TBA', aired: '2026-05-17' },
  ];

  test('[字]アニメ　…　第２期　作戦31　スパイ昇級試験 → S2E4 via subtitle name match', () => {
    const hit = findEpisodeForProgram(
      YOZAKURA_EPISODES,
      '2026-05-12T15:30:00.000Z',
      '[字]アニメ\u3000夜桜さんちの大作戦\u3000第２期\u3000作戦31\u3000スパイ昇級試験',
      ['夜桜さんちの大作戦'],
    );
    assert.deepEqual(hit, { s: 2, e: 4, name: 'スパイ昇級試験' });
  });

  test('bare kanji-prefix-digit strip preserves attribute-like tokens', () => {
    // Negative test: the strip must not eat `平成30年` (year) or
    // `刑事110キロ` (numeric attribute) when they appear in a subtitle.
    // Both are kanji-prefix-digit shape but lack the trailing whitespace
    // required by the new strip — the digit is followed by another kanji
    // (`年`) or kana (`キロ`), so the pattern doesn't fire.
    const list: Episode[] = [
      { s: 1, e: 1, name: '平成30年史を振り返る', aired: '2026-05-12' },
      { s: 1, e: 2, name: '刑事110キロ', aired: '2026-05-19' },
    ];
    // First case: subtitle exactly equals the episode name. Show titles
    // omitted so the legacy quoted-segment path is exercised — separately,
    // the strip rule must not corrupt the candidate when it does run.
    const hit1 = findEpisodeForProgram(
      list,
      '2026-05-12T10:00:00.000Z',
      'アニメ\u3000ショウ名\u3000「平成30年史を振り返る」',
      ['ショウ名'],
    );
    assert.deepEqual(hit1, { s: 1, e: 1, name: '平成30年史を振り返る' });
    const hit2 = findEpisodeForProgram(
      list,
      '2026-05-19T10:00:00.000Z',
      'ドラマ\u3000ショウ名\u3000「刑事110キロ」',
      ['ショウ名'],
    );
    assert.deepEqual(hit2, { s: 1, e: 2, name: '刑事110キロ' });
  });
});

describe('findEpisodeForProgram — cumulative fallback', () => {
  test('ダンダダン #18 with S1=12, S2=6 → S2E6', () => {
    // The motivating case. Broadcaster numbers continuously across
    // seasons; TVDB resets per season. Direct e===18 match fails, the
    // cumulative walker (12 < 18 ≤ 18) hits S2E(18-12)=S2E6.
    const list: Episode[] = [
      ...eps(1, 12, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(
      list,
      SOME_START,
      'ダンダダン　＃１８[再]「家族になりました」',
    );
    assert.deepEqual(hit, { s: 2, e: 6, name: 'S2 6' });
  });

  test('S1=12, S2=12, #20 → S2E8', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 12),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#20');
    assert.deepEqual(hit, { s: 2, e: 8, name: undefined });
  });

  test('S1=12, S2=6, S3=4, #20 → S3E2', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 6),
      ...eps(3, 4),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#20');
    assert.deepEqual(hit, { s: 3, e: 2, name: undefined });
  });

  test('cumulative does not steal a direct match', () => {
    // S1 has E15 directly, so #15 must stay on S1 even though the
    // cumulative formula would also be valid.
    const list: Episode[] = [
      ...eps(1, 20, 'S1'),
      ...eps(2, 5, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, '#15');
    assert.deepEqual(hit, { s: 1, e: 15, name: 'S1 15' });
  });

  test('out-of-range #N returns null (no aired hint)', () => {
    const list: Episode[] = [
      ...eps(1, 12),
      ...eps(2, 6),
    ];
    // #99 is past the entire run — neither direct nor cumulative match.
    const hit = findEpisodeForProgram(list, SOME_START, '#99');
    assert.equal(hit, null);
  });

  test('specials season (s=0) is skipped from cumulative walk', () => {
    // S0 specials shouldn't count toward the broadcaster's numbering.
    const list: Episode[] = [
      ...eps(0, 5, 'SP'),
      ...eps(1, 12, 'S1'),
      ...eps(2, 6, 'S2'),
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル #18');
    assert.deepEqual(hit, { s: 2, e: 6, name: 'S2 6' });
  });
});

describe('findEpisodeForProgram — aired fallback', () => {
  test('no #N in title → use broadcast-day aired match', () => {
    // jstBroadcastDay('2026-05-09T18:38:00.000Z') = 2026-05-10 03:38 JST
    // shifted -5h = 2026-05-09 (so the broadcast day is 2026-05-09).
    const list: Episode[] = [
      { s: 1, e: 7, aired: '2026-05-09', name: 'aired hit' },
      { s: 1, e: 8, aired: '2026-05-16' },
    ];
    const hit = findEpisodeForProgram(list, SOME_START, 'タイトル「副題」');
    assert.deepEqual(hit, { s: 1, e: 7, name: 'aired hit' });
  });

  test('no signal → null', () => {
    const list: Episode[] = [{ s: 1, e: 1 }];
    const hit = findEpisodeForProgram(list, SOME_START, '無題');
    assert.equal(hit, null);
  });
});

describe('findEpisodeForProgram — 孤独のグルメ regression case', () => {
  // Source: programs.id svc-400171_2026-05-10T08:45:00.000Z
  //   title: 孤独のグルメSeason11　３話　文京区のラムスパイシー炒めと豚バラきゅうり[字]
  //   tvdb_id 260548 matched but tvdbSeason/tvdbEpisode were NULL because
  //   parseTitleEpisodeNumber didn't recognise bare `N話` (no `第` prefix).
  //   The kantou commercial nets routinely drop the 第 prefix on a `<digit>話`
  //   episode marker, so this is a broadcaster-wide convention to support.
  test('bare "N話" without 第 prefix resolves to E=N, latest season', () => {
    const list: Episode[] = [
      { s: 11, e: 1, name: '第1話 神奈川県藤沢市善行のさばみりんと豚汁' },
      { s: 11, e: 2, name: '第2話 東京都港区西麻布のタンドリーチキン…' },
      {
        s: 11,
        e: 3,
        name: '第3話 東京都文京区千石のラムショルダー発酵菜スパイシー炒めと豚バラきゅうりガーリックソース',
      },
      { s: 11, e: 4, name: '第4話 本厚木のバーニャカウダと脾臓のパニーニ' },
    ];
    const hit = findEpisodeForProgram(
      list,
      '2026-05-10T08:45:00.000Z',
      '孤独のグルメSeason11　３話　文京区のラムスパイシー炒めと豚バラきゅうり[字]',
    );
    // showTitles omitted — exercises the legacy quoted-subtitle path which
    // doesn't fire here (no quoted segment), so resolution falls through
    // to the new bare-N話 step in parseTitleEpisodeNumber.
    assert.deepEqual(hit, {
      s: 11,
      e: 3,
      name: '第3話 東京都文京区千石のラムショルダー発酵菜スパイシー炒めと豚バラきゅうりガーリックソース',
    });
  });

  test('bare "４話" zenkaku digits work the same way', () => {
    const list: Episode[] = [
      { s: 11, e: 3, name: '第3話 …' },
      { s: 11, e: 4, name: '第4話 本厚木のバーニャカウダと脾臓のパニーニ' },
    ];
    const hit = findEpisodeForProgram(
      list,
      '2026-04-24T08:45:00.000Z',
      '孤独のグルメSeason11　４話　本厚木のバーニャカウダと脾臓のパニーニ[字]',
    );
    assert.deepEqual(hit, {
      s: 11,
      e: 4,
      name: '第4話 本厚木のバーニャカウダと脾臓のパニーニ',
    });
  });
});
