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
