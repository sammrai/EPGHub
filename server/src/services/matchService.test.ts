// Tests for normalizeTitle. Uses Node's built-in `node:test` so no dep needs
// to be added; run via `npm test` (which is `node --import tsx --test ...`).
//
// The job of normalizeTitle is: given a raw EPG title (with closed-caption
// markers, rerun flags, season/episode numbers, zenkaku digits, chapter
// prefixes, broadcaster/genre prefixes, and crosstalk tags), return the
// canonical show name suitable for a TVDB keyword search. The test cases
// below are sampled across the 2846 distinct program titles in the
// development DB as of 2026-04-19.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoOverrideValidForCohort,
  normalizeTitle,
  scoreOf,
  searchKeyCandidates,
  suggestRuleKeyword,
} from './matchService.ts';
import type { TvdbEntry } from '../schemas/tvdb.ts';

interface Case {
  raw: string;
  expected: string;
  note?: string;
}

// Short / edge cases --------------------------------------------------------
const edge: Case[] = [
  { raw: '', expected: '' },
  { raw: '   ', expected: '' },
  { raw: '[字]', expected: '', note: 'only a marker — no show name left' },
  { raw: '[字][解][デ][再]', expected: '' },
  { raw: '【動物】', expected: '動物', note: 'bracket content is all we have → keep it' },
  { raw: 'ニュース', expected: 'ニュース' },
  { raw: 'NHKニュース', expected: 'NHKニュース' },
];

// Short broadcaster markers -------------------------------------------------
const markers: Case[] = [
  { raw: 'ヒルナンデス！[デ]', expected: 'ヒルナンデス!' },
  { raw: 'どーも、ＮＨＫ[字]', expected: 'どーも、NHK' },
  { raw: 'ジャンクＳＰＯＲＴＳ[字]', expected: 'ジャンクSPORTS' },
  { raw: 'ほっと関西[字]', expected: 'ほっと関西' },
  { raw: 'ひょうご発信！[手]', expected: 'ひょうご発信!' },
  { raw: '[字]おんな酒場放浪記', expected: 'おんな酒場放浪記' },
  { raw: '[字][デ]太田和彦のふらり旅', expected: '太田和彦のふらり旅' },
  { raw: '目で聴くテレビ[手][再]', expected: '目で聴くテレビ' },
  { raw: 'キルアオ[字]', expected: 'キルアオ' },
  { raw: 'ミャクぷしゅ[字]', expected: 'ミャクぷしゅ' },
  { raw: 'ＫＢＳ京都ニュース', expected: 'KBS京都ニュース' },
];

// Long bracket episode-subtitles --------------------------------------------
const longBrackets: Case[] = [
  {
    raw: 'ドラえもん　【ウルトラスーパー電池】【きんとフード】[デ][字]',
    expected: 'ドラえもん',
    note: 'two consecutive 【】 blocks both stripped',
  },
  {
    raw: '武田鉄矢の昭和は輝いていた【昭和を駆け抜けた美しき歌声～松島詩子の歌人生】[字]',
    expected: '武田鉄矢の昭和は輝いていた',
  },
  {
    raw: '【連続テレビ小説】マッサン（８０）「渡る世間に鬼はない」[解][字]',
    expected: 'マッサン',
    note: '【連続テレビ小説】 prefix is a program-block label — strip',
  },
  {
    raw: '【連続テレビ小説】風、薫る　土曜ダイジェスト版　第３週[字][再]',
    expected: '風、薫る',
  },
  {
    raw: '【特選！時代劇】陽炎の辻～居眠り磐音　江戸双紙～　[新]（１）「友よ」[解][字]',
    expected: '陽炎の辻～居眠り磐音 江戸双紙～',
    note: '[新] marker + episode number + quoted chapter all stripped; ideographic space collapsed to ASCII',
  },
  {
    raw: 'ホンマでっか！？ＴＶ[字]【運を自力で上げる方法】',
    expected: 'ホンマでっか!?TV',
  },
  {
    raw: 'なるみ岡村過ぎるＴＶ【ミステリー過ぎる大阪神コスパグルメ▽宮野真守・神山智洋】[字]',
    expected: 'なるみ岡村過ぎるTV',
  },
];

// Angle-bracket tags (＜...＞) ----------------------------------------------
const angleBrackets: Case[] = [
  {
    raw: 'NEWSクライシス＜天竺川原×真空川北＞／はばたけ！アイドルフェス【カワイイ対決】[字]',
    expected: 'NEWSクライシス',
    note: 'tagged crosstalk + slash-separated second title + 【】 all stripped',
  },
  {
    raw: '＜ドラマ＞寺西一浩ミステリー・SPELL～死因～　第4話[終]',
    expected: '寺西一浩ミステリー・SPELL～死因～',
  },
  {
    raw: '＜お昼のサスペンス＞浅見光彦シリーズ50　貴賓室の怪人[字][解]',
    expected: '浅見光彦シリーズ50 貴賓室の怪人',
    note: '"50" sticks to "シリーズ" (no whitespace) and the trailing kanji-only subtitle has no `!` signal to trigger a cut. Accepted — TVDB includes-matching will still surface 浅見光彦シリーズ.',
  },
  {
    raw: '＜アニメギルド＞百妖譜 第1期・第2期 傑作選　#4',
    expected: '百妖譜',
  },
  {
    raw: '＜時代劇＞剣客商売　第5シリーズ　第1話「昨日の敵」[新][字]',
    expected: '剣客商売',
  },
  {
    raw: '＜BS土曜プレミアム＞華麗なる一族　第七話・第八話[字]',
    expected: '華麗なる一族',
  },
  {
    raw: 'シネマ「アパッチ」＜字幕スーパー＞＜レターボックスサイズ＞',
    expected: 'アパッチ',
  },
  {
    raw: '水戸黄門第２１部＜デジタルリマスター版＞「悪鬼が巣喰う岡崎城」（水戸・岡崎）後編',
    expected: '水戸黄門',
    note: '第N部 is season-ish; デジタルリマスター tag stripped; quoted is chapter',
  },
  {
    raw: '水曜アニメ＜水もん＞よわよわ先生 #2',
    expected: 'よわよわ先生',
  },
  {
    raw: '牙狼＜GARO＞ -魔戒ノ花-　第４話「映画」',
    expected: '牙狼 -魔戒ノ花-',
    note: '＜GARO＞ is a reading gloss — strip. Hyphen-surrounded subtitle kept',
  },
];

// Quoted inner titles -------------------------------------------------------
const quoted: Case[] = [
  {
    raw: '大河ドラマ「豊臣兄弟！」２分ダイジェスト（１５）[字]',
    expected: '豊臣兄弟!',
  },
  {
    raw: '[字]橋田壽賀子ドラマ「渡る世間は鬼ばかり」第６シリーズ▼第１４話',
    expected: '渡る世間は鬼ばかり',
  },
  {
    raw: '[字]人生、歌がある　「「二輪草」「遣らずの雨」ほか…川中美幸名場面集！」',
    expected: '人生、歌がある',
    note: 'outer quoted block is a setlist — prefer leading show name',
  },
  {
    raw: '韓国時代劇「朱蒙（チュモン）」　＃６６【デイリーセレクション】(字幕スーパー)[二]',
    expected: '朱蒙（チュモン）',
  },
  {
    raw: 'TVアニメ「カードファイト!! ヴァンガード」15周年リマスター　第2話',
    expected: 'カードファイト!! ヴァンガード',
  },
  {
    // Issue #46: `テレビアニメ` long-form prefix sibling of `TVアニメ`.
    // Was normalising to `テレビアニメ シリーズ全編` because `テレビアニメ`
    // wasn't a recognised BLOCK_PREFIX; the QUOTED_HOST branch never
    // fired, the inner `「鬼滅の刃」` got dropped as a chapter subtitle,
    // and the leading `テレビアニメ` survived. The trailing arc bracket
    // `【竈門炭治郎 立志編】` is correctly discarded along with the
    // broadcaster flags.
    raw: 'テレビアニメ「鬼滅の刃」シリーズ全編再放送[字][解][デ]【竈門炭治郎　立志編】',
    expected: '鬼滅の刃',
  },
  {
    raw: 'シネマ「クィーン」＜字幕スーパー＞＜レターボックスサイズ＞',
    expected: 'クィーン',
  },
  {
    raw: '映画「ロボコップ３」▽三部作最終章！怒りのロボコップが企業の謀略に立ち向かう！',
    expected: 'ロボコップ3',
  },
  {
    raw: '映画「ヴェノム」[二]',
    expected: 'ヴェノム',
  },
  {
    raw: 'ザ・ミステリー『刑事吉永誠一　涙の事件簿１０　沈黙の宴』[字]',
    expected: '刑事吉永誠一 涙の事件簿10 沈黙の宴',
    note: 'Inner quoted extracted; series+chapter+episode all kept because "10" has no whitespace before it to trigger a cut. TVDB "includes" matching on 刑事吉永誠一 is still fine.',
  },
  {
    raw: '『Dr.STONE SCIENCE FUTURE』第3クール　＃28',
    expected: 'Dr.STONE SCIENCE FUTURE',
  },
  {
    // Issue #29: all-zenkaku Dr.STONE title (including fullwidth `．`
    // U+FF0E). Without the `．` → `.` fold in zenkakuToHankaku, the
    // normalized key would be `Dr．STONE SCIENCE FUTURE` and the TVDB
    // title `Dr.STONE` (ASCII period) fails every comparator in scoreOf.
    raw: 'Ｄｒ．ＳＴＯＮＥ　ＳＣＩＥＮＣＥ　ＦＵＴＵＲＥ　第31話',
    expected: 'Dr.STONE SCIENCE FUTURE',
    note: 'fullwidth `．` (U+FF0E) folded to ASCII `.` so the key compares equal to TVDB `Dr.STONE`',
  },
  {
    // Issue #30: same show, different broadcaster shape — `第３クール
    // （第３１話）` season-then-cumulative-episode in fullwidth. The
    // CUT_AT_SEASON_RE cuts at `第3クール` and the trailing `（第３１話）`
    // is consumed too, leaving the canonical show name.
    raw: 'Ｄｒ．ＳＴＯＮＥ　ＳＣＩＥＮＣＥ　ＦＵＴＵＲＥ　第３クール（第３１話）',
    expected: 'Dr.STONE SCIENCE FUTURE',
  },
  {
    raw: '『Re:ゼロから始める異世界生活』4th season　第69話',
    expected: 'Re:ゼロから始める異世界生活',
  },
];

// Season / episode patterns -------------------------------------------------
const seasonEp: Case[] = [
  { raw: 'こめかみっ！Girls　＃３', expected: 'こめかみっ!Girls' },
  { raw: '転生したらスライムだった件 第4期　＃76', expected: '転生したらスライムだった件' },
  {
    raw: '[新][字]アニメ　夜桜さんちの大作戦　第２期　作戦28',
    expected: '夜桜さんちの大作戦',
  },
  {
    raw: '悲劇の元凶となる最強外道ラスボス女王は民の為に尽くします。Season2　第３話',
    expected: '悲劇の元凶となる最強外道ラスボス女王は民の為に尽くします。',
  },
  {
    raw: '[解][字]相棒 season 18　2話連続放送「檻の中～陰謀」「檻の中～告発」',
    expected: '相棒',
  },
  {
    raw: '[新]孤独のグルメSeason11　第１話　神奈川県藤沢市善行のさばみりんと豚汁[字]',
    expected: '孤独のグルメ',
  },
  {
    raw: 'ドラマ24孤独のグルメSeason11　４話　本厚木のバーニャカウダと脾臓のパニーニ[字]',
    expected: 'ドラマ24孤独のグルメ',
    note: 'ドラマ24 is a show-block prefix but kept because it qualifies the show slot',
  },
  {
    raw: 'アニメ　自動販売機に生まれ変わった俺は迷宮を彷徨う 3rd season　＃４',
    expected: '自動販売機に生まれ変わった俺は迷宮を彷徨う',
  },
  {
    raw: 'アニメ　ようこそ実力至上主義の教室へ 4th Season 2年生編1学期　第７話',
    expected: 'ようこそ実力至上主義の教室へ',
    note: 'Cut at "4th Season" takes out the named arc too. Accepted — the bare show title still matches on TVDB.',
  },
  {
    raw: 'ヴェラ～信念の女警部～ シーズン11　＃６「消えた少年（後編）」',
    expected: 'ヴェラ～信念の女警部～',
  },
  {
    raw: '22/7計算外 season3　＃４',
    expected: '22/7計算外',
  },
  {
    raw: '第７４回　ＮＨＫ杯テレビ囲碁トーナメント　１回戦第３局　大西七段×辻五段[字]',
    expected: 'NHK杯テレビ囲碁トーナメント',
    note: 'leading 第N回 is the edition number — strip',
  },
  {
    raw: '白玲～女流棋士No.1決定戦～第48回',
    expected: '白玲～女流棋士No.1決定戦～',
  },
  {
    raw: '顔に出ない柏田さんと顔に出る太田君（第３話）',
    expected: '顔に出ない柏田さんと顔に出る太田君',
  },
  {
    raw: 'ドラマ１５　三国志～趙雲伝～[吹]（第５８話）',
    expected: '三国志～趙雲伝～',
  },
  {
    raw: 'アニメ　株式会社マジルミエ　第2話 ホーキなんて楽勝だから',
    expected: '株式会社マジルミエ',
  },
  {
    raw: '御宿かわせみ　第２シリーズ（１９８２年版）（２１）吉野の女[字]',
    expected: '御宿かわせみ',
  },
  {
    raw: '中国時代劇　蘭陵王　第41話「狙われた二つの命」（全46話）',
    expected: '蘭陵王',
    note: '（全46話）total-episode suffix stripped along with chapter',
  },
  {
    raw: '[新]韓国時代劇「太宗イ・バンウォン～龍の国～」第１話（字幕）全36話',
    expected: '太宗イ・バンウォン～龍の国～',
  },
  {
    raw: '落語研究会▼第２４１回「強情灸」柳家喬太郎、「応挙の幽霊」柳家さん喬',
    expected: '落語研究会',
    note: '▼ followed by 第N回 — strip the whole tail',
  },
  {
    raw: 'アニメ　HUNTER×HUNTER　第１３０話　マホウ×デ×ゼツボウ',
    expected: 'HUNTER×HUNTER',
  },
  {
    raw: '７時のアニメ(木)赤毛のアン　＃１７　アン、学校にもどる',
    expected: '赤毛のアン',
    note: '(木) weekday tag stripped; 7時のアニメ is a block prefix',
  },
  {
    raw: '無職転生Ⅱ ～異世界行ったら本気だす～　第五話「ラノア魔法大学」',
    expected: '無職転生 ～異世界行ったら本気だす～',
    note: '第五話 stripped + Ⅱ stripped (TRAILING_KANA_ROMAN_RE — sequel marker between show name and ～subtitle～). TVDB carries the no-Ⅱ canonical form. Source: programs.id svc-400211_2026-05-10T14:30:00.000Z',
  },
  {
    raw: '進撃の巨人Ⅱ',
    expected: '進撃の巨人',
    note: 'fullwidth Ⅱ at end-of-string after kana/kanji — sequel marker stripped',
  },
  {
    raw: 'ダイヤのA actⅡ－Second Season－',
    expected: 'ダイヤのA actⅡ－Second Season－',
    note: 'Ⅱ followed by `－` (em-dash), NOT whitespace/end → not a sequel marker, preserved. Lookahead in TRAILING_KANA_ROMAN_RE guards this.',
  },
  {
    raw: 'Test Ⅱ',
    expected: 'Test Ⅱ',
    note: 'Ⅱ preceded by ASCII space, lookbehind requires CJK kana/kanji → not stripped. Protects English titles.',
  },
  {
    raw: 'シネマ「ロッキーⅡ」',
    expected: 'ロッキーⅡ',
    note: 'extracted from quote (wasQuoteExtracted=true) → Roman strip skipped; the Ⅱ is part of the canonical film title (Rocky II)',
  },
];

// (秘) and ▼/▽ tail descriptors -------------------------------------------
const maruHi: Case[] = [
  {
    raw: '(秘)衝撃ファイル【動物(秘)ハプニング＆極限！航空パニック＆謎解明！戦慄の(秘)真相SP】[字]',
    expected: '衝撃ファイル',
    note: 'leading (秘) stripped; inner (秘) inside 【】 stripped with the block',
  },
  {
    raw: 'The Classic Car▼1951年製 FIAT ERMINI 1100 SPORT Siluro[字]',
    expected: 'The Classic Car',
  },
  {
    raw: 'ピタゴラスイッチ▽香川しんじ装置[字]',
    expected: 'ピタゴラスイッチ',
  },
  {
    raw: '熱唱！僕らの名曲ショー▼細川たかし名曲の世界',
    expected: '熱唱!僕らの名曲ショー',
    note: '！ folded to ! consistently with other cases',
  },
  {
    raw: '[字]カンニング竹山の昼酒は人生の味。▼上野（後編）２ｎｄ',
    expected: 'カンニング竹山の昼酒は人生の味。',
  },
  {
    raw: 'ダーウィンが来た！「徹底解明！ナマズの超能力」[解][字]',
    expected: 'ダーウィンが来た!',
    note: 'Quoted subtitle attached to exclamation-ending show name — prefer the show',
  },
];

// Suffixes: 前編/後編/特別編/最終回/SP/etc. ------------------------------
const suffixes: Case[] = [
  {
    raw: 'JAPANをスーツケースにつめ込んで！～世界に日本を持ってった～（後編）[字]',
    expected: 'JAPANをスーツケースにつめ込んで!～世界に日本を持ってった～',
  },
  {
    raw: 'MOTORISE　バイク女子！“埼玉・秩父ツーリング”前編',
    expected: 'MOTORISE',
    note: 'Primary show name + an event description containing "!" — cut at the wide space',
  },
  {
    raw: 'ごりやくさん　第50回「総集編」',
    expected: 'ごりやくさん',
  },
  {
    raw: 'はやく起きた朝は…BS傑作選[解][字]',
    expected: 'はやく起きた朝は…',
  },
  {
    raw: 'ザ・プロファイラー　秀吉支えた天下のナンバー２　豊臣秀長[字][再]',
    expected: 'ザ・プロファイラー 秀吉支えた天下のナンバー2 豊臣秀長',
    note: 'Borderline: episode topic after ideographic space but no "!" signal — kept. TVDB "includes" scoring will still surface ザ・プロファイラー.',
  },
  {
    raw: '【連続テレビ小説】ひまわり（５）「第一章　出るクイは打たれるの？」[解][字][再]',
    expected: 'ひまわり',
  },
];

// Genre / block prefixes ---------------------------------------------------
const prefixes: Case[] = [
  {
    raw: 'アニメ　おじゃる丸「小町とオカメ」[字]',
    expected: 'おじゃる丸',
  },
  {
    raw: 'アニメ　BanG Dream! It\'s MyGO!!!!!　＃１２',
    expected: "BanG Dream! It's MyGO!!!!!",
  },
  {
    raw: '[新]ドラマ　あぶない刑事',
    expected: 'あぶない刑事',
  },
  {
    raw: '[字]時代劇　八百八町夢日記　第２３話「海が匂う客」▽里見浩太朗主演',
    expected: '八百八町夢日記',
  },
  {
    raw: '中国時代劇　鳳凰の飛翔　第41話（全70話）',
    expected: '鳳凰の飛翔',
  },
  {
    raw: '韓国時代劇　薯童謠／ソドンヨ「第46話　行き詰まる譲位計画」（字幕）全74話',
    expected: '薯童謠／ソドンヨ',
  },
  {
    raw: '時代劇スペシャル「御家人斬九郎　第３シリーズ・男二人」',
    expected: '御家人斬九郎',
  },
  {
    raw: 'BSフジLIVE　プロ野球2026　東京ヤクルトスワローズ×読売ジャイアンツ[多]',
    expected: 'BSフジLIVE プロ野球2026 東京ヤクルトスワローズ×読売ジャイアンツ',
    note: 'Generic sports telecast — no useful "show" to extract. Keep as-is.',
  },
  {
    raw: 'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女 Season2　第18話',
    expected: 'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女',
    note: 'Broadcaster-block prefix preserved at normalize-time; Season2 + ep number tail cut. `searchKeyCandidates` tail fallback resolves the show name structurally. Source: issue #35.',
  },
  {
    raw: 'BS11ガンダムアワー 機動戦士ガンダム THE ORIGIN 前夜 赤い彗星　第９話',
    expected: 'BS11ガンダムアワー 機動戦士ガンダム THE ORIGIN 前夜 赤い彗星',
    note: 'Broadcaster-block prefix preserved; arc subtitle stays in show name. `searchKeyCandidates` tail fanout finds the TVDB entry. Source: issue #34.',
  },
  {
    raw: 'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女 Season2　第21話',
    expected: 'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女',
    note: 'Broadcaster-block prefix preserved; ep 21 is cumulative (TVDB Season 1 episode 21). Source: issue #35.',
  },
  {
    raw: 'ＢＳ１１ガンダムアワー 機動戦士ガンダム 水星の魔女 Season2　第21話',
    expected: 'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女',
    note: 'Zenkaku BS11 variant — the zenkaku→hankaku fold normalises BS11 prefix to ASCII form; the prefix itself is preserved for tail-fanout resolution.',
  },
  {
    raw: 'NEXT company「野生鳥獣被害解決の切り札に？自立走行巡回ロボット」',
    expected: 'NEXT company',
    note: 'The quoted chunk is the episode topic, not the show name',
  },
  {
    raw: '火アニバル　マリッジトキシン　＃０７[字]　「蟲使いの結婚式」毒をもって恋を制す！',
    expected: '火アニバル マリッジトキシン',
    note: 'Fuji TV "Tuesday anime" block prefix (`<weekday-block> <show>` shape). `火アニバル` is not catalogued in BLOCK_PREFIXES — same design as `BS11ガンダムアワー` (issues #34/#35): the broadcaster prefix stays attached at normalize-time and the `searchKeyCandidates` tail fanout (`マリッジトキシン`) resolves the show via TVDB. `＃０７[字]` + quoted episode subtitle + promo tail all strip cleanly. Source: programs.id svc-3272402080_2026-05-19T14:00:00.000Z (issue #44).',
  },
];

// Zenkaku handling ---------------------------------------------------------
const zenkaku: Case[] = [
  { raw: 'Ｅｎｊｏｙ！ショッピング', expected: 'Enjoy!ショッピング' },
  { raw: 'ＧＡＫＵＯＮ！', expected: 'GAKUON!' },
  {
    raw: 'Ｆ　ＪＵＮＣＴＩＯＮ　第２４回',
    expected: 'F JUNCTION',
  },
  {
    raw: 'ｎｅｗｓランナー[字]　アポロ１３号以来快挙地球外生命体は存在？関西に日本初の組織も',
    expected: 'newsランナー',
    note: 'the descriptive tail after the ideographic space is banter — strip',
  },
  {
    raw: '　商道－サンド－　７４',
    expected: '商道－サンド－',
    note: 'leading ideographic space + trailing episode number only',
  },
];

// Big borderline grid ------------------------------------------------------
const borderline: Case[] = [
  {
    raw: 'ウッド・ペッカー　２',
    expected: 'ウッド・ペッカー',
    note: 'trailing " 2" is an episode index',
  },
  {
    raw: 'トムとジェリー　１３',
    expected: 'トムとジェリー',
  },
  {
    raw: 'ピタゴラスイッチ▽みずにうくからできること　ＳＰ[字]',
    expected: 'ピタゴラスイッチ',
  },
  {
    raw: '[新]真剣遊戯！ＴＨＥバトルＳＨＯＷ[字]★ＭＣ櫻井翔！豪華絢爛ゲームバラエティー開幕！',
    expected: '真剣遊戯!THEバトルSHOW',
    note: 'the ★...! chunk is a promo blurb — strip on ★',
  },
  {
    raw: 'なにわ男子の逆転男子　完コピ漫才後半戦！マユリカ＆東京ホテイソンにガチ挑戦！[字]',
    expected: 'なにわ男子の逆転男子',
  },
  {
    raw: 'ホンマでっか！？ＴＶ[字]',
    expected: 'ホンマでっか!?TV',
  },
  {
    raw: '『BEYBLADE　X』オンエア争奪バトル！[字][デ]',
    expected: 'BEYBLADE X',
  },
  {
    raw: 'アニメ　『ポンコツクエスト～魔王と派遣の魔物たち～』　シーズン８',
    expected: 'ポンコツクエスト～魔王と派遣の魔物たち～',
  },
  {
    raw: 'ヨーロッパ絶景の道「イタリアからオーストリアへ」',
    expected: 'ヨーロッパ絶景の道',
  },
  {
    raw: 'お買い物チャンネル　QVC',
    expected: 'お買い物チャンネル QVC',
    note: 'no noise to strip; ideographic space preserved as a single ASCII space',
  },
  {
    raw: '世界で開け！ひみつのドアーズ　広報番組　２分でわかる！見どころご紹介！！[字]',
    expected: '世界で開け!ひみつのドアーズ',
    note: 'after ideographic space, the 2nd half is a promo clause — strip',
  },
  {
    raw: '有吉のお金発見　突撃！カネオくん　いま世界が注目！最新「畳」事情を大調査[字]',
    expected: '有吉のお金発見 突撃!カネオくん',
    note: 'embedded-! show-name carve-out in stripPromoTail: 3 segments where seg2 (`突撃！カネオくん`) carries a non-terminal `!` is preserved as part of the show name; seg3 onward is the promo blurb. Source: programs.id svc-3211240960_2026-05-10T09:05:00.000Z (issue #18).',
  },
  {
    raw: 'ＬａＬａ　ＴＶ「コンコンパッパッ～今日から芸農人！～」＃１　［字］',
    expected: 'LaLa TV',
    note: 'LaLa TV is not a known block prefix so the quoted content is treated as an episode subtitle and stripped. This keeps TVDB searching on "LaLa TV" which is safer than a weekly show name.',
  },
  {
    raw: '[字]Fresh　Faces　＃550 木下こづえ、木下さとみ',
    expected: 'Fresh Faces',
    note: 'cut at #550 takes out everything after, including the guest list',
  },
  {
    raw: '異世界のんびり農家２',
    expected: '異世界のんびり農家',
    note: 'sequel/season number directly suffixed to a kana/kanji title — strip so TVDB search finds the canonical entry. Source: programs.id svc-400171_2026-05-12T15:30:00.000Z',
  },
  {
    raw: '進撃の巨人3',
    expected: '進撃の巨人',
    note: 'hankaku single-digit sequel suffix on an anime title',
  },
  {
    raw: 'ハチ公20',
    expected: 'ハチ公20',
    note: 'two-digit suffix is NOT stripped — could be year/total-episodes/etc.',
  },
  {
    raw: '日５「夜桜さんちの大作戦」　＃３２「愛の結晶」([字][デ]',
    expected: '夜桜さんちの大作戦',
    note: 'NTV 日5 weekday+hour slot shorthand. BLOCK_PREFIXES carries one general regex `[日月火水木金土]\\d+` covering the whole class (日5/月9/火10/木10/金10/土6/...) so the inner quoted segment is extracted as the show name. `searchCandidates` is the fall-through safety net for future slot labels not matched by the regex. Source: programs.id svc-3272202064_2026-05-10T08:00:00.000Z',
  },
  {
    raw: 'アニメA・メイドさんは食べるだけ　6食目「うなぎ／冷奴／お祭り」',
    expected: 'メイドさんは食べるだけ',
    note: 'AT-X "Anime A" slot brand uses `・` as separator (general regex `アニメ[A-Z]・` in BLOCK_PREFIXES with the `(?<=・)` lookbehind path in BLOCK_PREFIX_RE absorbs it). 6食目 is a cooking-themed thematic episode counter (sibling shape of the bare `<digit>話/回` form already in CUT_AT_BARE_EP_RE). Source: programs.id svc-400151_2026-05-10T14:00:00.000Z',
  },
  {
    raw: 'アニメA・あかね噺',
    expected: 'あかね噺',
    note: 'AT-X slot prefix strip without trailing episode marker — confirms `アニメ[A-Z]・` works in isolation.',
  },
  {
    raw: 'ドラマ・よかれと思ってやったのに～男たちの「失敗学」裁判～▼ゆるさない女',
    expected: 'ドラマ・よかれと思ってやったのに～男たちの 裁判～',
    note: 'Bare `ドラマ・` is NOT stripped — the lookbehind path only fires for prefix entries that embed `・` themselves (e.g. `アニメ[A-Z]・`). Generic `ドラマ` literal still requires `[\\s　]+` separator, preserving the historical normalization.',
  },
  {
    raw: 'アニメ　魔入りました！入間くん４（６）「音楽祭、本番！！」[字]',
    expected: '魔入りました!入間くん',
    note: 'Two coupled markers on one EPG title: the bare `アニメ　` block prefix (full-width-space separator, generic `アニメ` literal in BLOCK_PREFIXES + `[\\s　]+` separator in BLOCK_PREFIX_RE) and the trailing season digit `４` glued to kana `くん` (TRAILING_KANA_DIGIT_RE after the `（６）` daily-ep paren and `「音楽祭、本番！！」` subtitle quote get stripped). Together they reduce to the canonical TVDB title. Source: programs.id svc-3272102056_2026-05-15T10:00:00.000Z (issue #13).',
  },
  {
    raw: '本好きの下剋上　領主の養女　第六章「フェシュピールコンサート」[字][デ]',
    expected: '本好きの下剋上 領主の養女',
    note: 'Generic `第N+kanji` cut: `章` is not in the historical closed-counter list (`期|シリーズ|部|話|回|夜|局|クール|食目|週`) but is now caught by the open-class branch, gated by a structural-boundary lookahead (here: `「`). Sibling shape of `輪`/`席`/`食目`/`羽`/`集`. Source: programs.id svc-3272502088_2026-05-16T08:30:00.000Z (issue #14).',
  },
  {
    raw: 'アニメ　ニワトリ・ファイター　第六羽',
    expected: 'ニワトリ・ファイター',
    note: 'Open-class `第N<kanji>` cut where the boundary is end-of-string. `羽` is the bird counter — same kanji-counter shape as `章` from issue #14, generalised so future shows that pick a fresh thematic glyph just work without code changes.',
  },
  {
    raw: '第一三共ヘルスケアダイレクトテレビショッピング',
    expected: '第一三共ヘルスケアダイレクトテレビショッピング',
    note: 'Negative test for the generic `第N+kanji` cut: `第一三共` is the company name Daiichi Sankyo, not a structural marker. Preserved by (a) the kanji-digit negative lookahead so `三` (a kanji-digit char) cannot itself be the counter and (b) the structural-boundary lookahead which rejects `共` followed by another kanji `ヘ`-prefixed katakana run.',
  },
  {
    raw: '国会中継「参議院決算委員会質疑」　～参議院第１委員会室から中継～[字]',
    expected: '国会中継 ～参議院第1委員会室から中継～',
    note: 'Negative test for the open-class branch: `第1委員会室` is a Diet committee room name. `委` is open-class but the boundary lookahead rejects it because the next char is the kanji `員`, not whitespace/quote/end. Preserves the existing normalization.',
  },
  {
    raw: 'ゴーストコンサート：ｍｉｓｓｉｎｇ　Ｓｏｎｇｓ　＃０６',
    expected: 'ゴーストコンサート:missing Songs',
    note: 'Issue #21: zenkaku `：` (U+FF1A) folds to ASCII `:` (sibling of the existing `？！＃` folds in zenkakuToHankaku) so `<show>：<subtitle>` lands in the same canonical form as `<show>:<subtitle>`. The scoreOf-side `\\s*:\\s*` collapse handles the broadcaster-vs-TVDB spacing drift around the colon. Source: programs.id svc-3272402080_2026-05-10T16:25:00.000Z.',
  },
  {
    raw: 'ＷＩＬＤ　ＢＬＵＥのわぶっていきましょう！[再]',
    expected: 'WILD BLUEのわぶっていきましょう!',
    note: 'Issue #22: ASCII-brand wide-space carve-out in stripPromoTail. The folded form `WILD BLUE…!` would otherwise be cut at the first whitespace (between `WILD` and `BLUE`) because the tail carries kana+`!`, leaving just `WILD` — which the matcher then bound to TVDB id 3496 (`Wild`, 4 chars). With both seg1 and seg2-leader being pure-ASCII letters, the whitespace is intra-brand, not a show↔promo boundary, so promo-tail bails out and the full title survives. The matching `searchKeyCandidates` guard suppresses the head fanout for the same shape so `WILD` is never used as a search key on its own. Source: programs.id svc-3272302072_2026-05-10T16:10:00.000Z.',
  },
];

const allCases: Case[] = [
  ...edge,
  ...markers,
  ...longBrackets,
  ...angleBrackets,
  ...quoted,
  ...seasonEp,
  ...maruHi,
  ...suffixes,
  ...prefixes,
  ...zenkaku,
  ...borderline,
];

for (const c of allCases) {
  const title = `normalize(${JSON.stringify(c.raw)})${c.note ? ` — ${c.note}` : ''}`;
  test(title, () => {
    const got = normalizeTitle(c.raw);
    assert.equal(got, c.expected);
  });
}

// -------------------------------------------------------------------
// Complexity guards. The skill's "Don't pick — enumerate" principle
// (see fix-episode-match SKILL.md) wants per-literal whitelist growth
// to be visible and reviewed. These tests fail when:
//   1. BLOCK_PREFIXES grows past the snapshot count, or
//   2. The ratio of literal entries to general regex entries shifts
//      toward more literals (each new literal asks "could this have
//      been a general regex instead?").
// Bumping the snapshot is intentional — it's the review checkpoint.
// -------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const matchServiceSource = readFileSync(
  resolve(__dirname, 'matchService.ts'),
  'utf8',
);

// Pull the BLOCK_PREFIXES literal array out of source. Doing this by
// regex rather than by re-importing keeps the test independent of any
// runtime export — adding a `module-private` entry still gets caught.
function extractBlockPrefixes(): string[] {
  const m = matchServiceSource.match(
    /const BLOCK_PREFIXES\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!m) throw new Error('BLOCK_PREFIXES literal not found in matchService.ts');
  // Strip line comments, then pull each single-quoted entry.
  const body = m[1].replace(/\/\/.*$/gm, '');
  const items: string[] = [];
  for (const im of body.matchAll(/'((?:\\'|[^'])*)'/g)) {
    items.push(im[1]);
  }
  return items;
}

// A literal entry has no regex meta-characters — it matches exactly
// one fixed string (`日曜劇場`, `アニメ`). A general regex entry
// (`\d+時のアニメ`, `[日月火水木金土]\d+`) covers a structural class
// and substitutes for many literals.
function isGeneralRegex(entry: string): boolean {
  return /\\d|\\w|\\s|\[|\(|\?|\*|\+|\{|\|/.test(entry);
}

describe('matchService whitelist complexity guards', () => {
  test('BLOCK_PREFIXES size is locked — bump deliberately', () => {
    const prefixes = extractBlockPrefixes();
    // Snapshot. When you legitimately need to extend, bump here AND
    // justify the addition in the PR (general regex preferred over
    // literal). The skill's per-literal anti-pattern check fires
    // when this grows by literals more often than by regexes.
    // Reverted 19→18: `BS11ガンダムアワー` removed — broadcaster-specific
    // block prefixes now resolve via the `searchKeyCandidates` tail
    // fallback instead of a hardcoded literal (issues #34/#35).
    // Bumped 18→19: `テレビアニメ` added — long-form anime-block prefix
    // siblings the existing `TVアニメ` / `アニメ` literals; no general
    // regex captures it cleanly (the bare `アニメ` literal would absorb
    // `テレビ` into the show name) so it's a separate entry (issue #46).
    const SNAPSHOT_LIMIT = 19;
    assert.ok(
      prefixes.length <= SNAPSHOT_LIMIT,
      `BLOCK_PREFIXES grew to ${prefixes.length} (limit ${SNAPSHOT_LIMIT}). ` +
        `Either consolidate two literals into one general regex, or bump the ` +
        `limit and document the addition (see fix-episode-match SKILL.md › ` +
        `"Whitelist judgement").`,
    );
  });

  test('majority of BLOCK_PREFIXES are literals — track regex ratio', () => {
    const prefixes = extractBlockPrefixes();
    const general = prefixes.filter(isGeneralRegex).length;
    const literal = prefixes.length - general;
    // Locks the *ratio*, not absolute counts. Adding a literal moves
    // this toward "more literals than regexes" — at which point the
    // assertion forces a re-think (would a general regex absorb the
    // class instead?).
    assert.ok(
      general >= 2,
      `Expected at least 2 general-regex entries in BLOCK_PREFIXES, got ${general}. ` +
        `If you removed a regex, replace it with a literal class equivalent ` +
        `or the diversity guard loses meaning.`,
    );
    // Sanity: enumerate counts so test failures show a useful diff.
    assert.equal(general + literal, prefixes.length);
  });
});

// -------------------------------------------------------------------
// Search-key fan-out. The auto-matcher tries the primary normalized
// key first, then falls back to a leading-token candidate. Trailing
// structural sequel markers (kana-glued digits, fullwidth Roman
// numerals) are folded at normalize-time via TRAILING_KANA_DIGIT_RE /
// TRAILING_KANA_ROMAN_RE so they do NOT spawn extra TVDB searches.
// -------------------------------------------------------------------

describe('searchKeyCandidates — show-name resolution fan-out', () => {
  test('primary key alone when no whitespace token to fall back to', () => {
    const got = searchKeyCandidates('鬼滅の刃');
    assert.deepEqual(got, ['鬼滅の刃']);
  });

  test('documentary-style "<show> <subtitle>" → primary + head + tail', () => {
    // `ブラタモリ 国宝犬山城` falls back to the leading token (the
    // documentary-style show name) AND the trailing tokens (covers the
    // broadcaster-block-prefix shape — see BS11 test below). Callers
    // iterate and stop at the first scoring hit, so the head is tried
    // before the tail.
    const got = searchKeyCandidates('ブラタモリ 国宝犬山城');
    assert.deepEqual(got, ['ブラタモリ 国宝犬山城', 'ブラタモリ', '国宝犬山城']);
  });

  test('broadcaster-block prefix → tail resolves the show name (issues #34/#35)', () => {
    // Issue #34/#35: programs.id `svc-400211_2026-05-16T10:00:00.000Z` /
    // `svc-400211_2026-05-16T10:30:00.000Z`. After normalize the EPG
    // key preserves the `BS11ガンダムアワー` block prefix (no more
    // hardcoded literal in BLOCK_PREFIXES). Head fanout produces
    // `BS11ガンダムアワー` (no TVDB hit). Tail fanout produces
    // `機動戦士ガンダム 水星の魔女` — the clean show name TVDB matches
    // at exact-tier (scoreOf 1000). This is the structural answer to
    // "how do we handle a broadcaster prefix we haven't catalogued?":
    // let the search-fanout phase try removing it, and let scoring
    // confirm the correct candidate.
    const got = searchKeyCandidates('BS11ガンダムアワー 機動戦士ガンダム 水星の魔女');
    assert.deepEqual(got, [
      'BS11ガンダムアワー 機動戦士ガンダム 水星の魔女',
      'BS11ガンダムアワー',
      '機動戦士ガンダム 水星の魔女',
    ]);
  });

  test('Fuji TV weekday-anime block prefix → tail resolves show (issue #44)', () => {
    // Issue #44: programs.id `svc-3272402080_2026-05-19T14:00:00.000Z`,
    // raw EPG title `火アニバル　マリッジトキシン　＃０７[字]　…`.
    // After normalize the key is `火アニバル マリッジトキシン` —
    // `火アニバル` (Fuji TV "Tuesday anime" slot brand) is NOT in
    // BLOCK_PREFIXES, following the same structural design as
    // `BS11ガンダムアワー` (issues #34/#35). The primary candidate and
    // the head `火アニバル` both miss on TVDB (no entry for the
    // slot label); the tail `マリッジトキシン` resolves cleanly to
    // tvdb_id 468734 at scoreOf 1000. Locks the candidate ordering
    // for the weekday-anime slot shape.
    const got = searchKeyCandidates('火アニバル マリッジトキシン');
    assert.deepEqual(got, [
      '火アニバル マリッジトキシン',
      '火アニバル',
      'マリッジトキシン',
    ]);
  });

  test('head shorter than 3 chars is NOT added (avoids stop-word blowups)', () => {
    // `AB CDE` — head 'AB' is 2 chars, dropped. Tail 'CDE' is 3-char
    // ASCII (minTailLen=4), also dropped.
    const got = searchKeyCandidates('AB CDE');
    assert.deepEqual(got, ['AB CDE']);
  });

  test('3-char ASCII head IS promoted; collision defense moved to scoring layer (issue #11)', () => {
    // Issue #11: `BAR レモン・ハート 恋の入門ウイスキー` previously had
    // its head `BAR` dropped here by a minHeadLen=4 ASCII guard, to
    // prevent the head fanout from matching TVDB's generic `Bar`
    // (tvdb_id 414326) at the case-insensitive exact tier (950).
    // That defense moved to `scoreSide`: short pure-ASCII keys hit
    // the 950 CJK admissibility gate and return 0. The candidate list
    // here is now a pure structural relaxation. See the
    // `scoreSide — 950 case-insensitive exact tier CJK gate` describe
    // block below for the actual defense layer.
    const got = searchKeyCandidates('BAR レモン・ハート 恋の入門ウイスキー');
    assert.deepEqual(got, [
      'BAR レモン・ハート 恋の入門ウイスキー',
      'BAR',
      'レモン・ハート 恋の入門ウイスキー',
    ]);
  });

  test('3-char CJK kana/kanji head IS promoted (and matches at scoring layer)', () => {
    // Sibling case to the BAR test above: 3-char CJK heads like
    // `タッチ` are admitted (no minHeadLen split, no CJK gate at the
    // candidate layer). `scoreSide`'s 950 gate is keyed on the
    // *absence* of CJK, so `タッチ` passes through and matches TVDB's
    // `タッチ` exactly. Tail also fans out.
    const got = searchKeyCandidates('タッチ 全国大会編');
    assert.deepEqual(got, ['タッチ 全国大会編', 'タッチ', '全国大会編']);
  });

  test('duplicate primary/head deduped', () => {
    const got = searchKeyCandidates('鬼滅');
    assert.deepEqual(got, ['鬼滅']);
  });

  test('ASCII-brand wide-space split is NOT promoted (issue #22: `WILD` of `WILD BLUE…` must not fan out)', () => {
    // Issue #22: programs.id `svc-3272302072_2026-05-10T16:10:00.000Z`.
    // `ＷＩＬＤ　ＢＬＵＥのわぶっていきましょう！[再]` normalises to
    // `WILD BLUEのわぶっていきましょう!` (the stripPromoTail carve-out
    // for an ASCII-brand wide-space keeps the brand intact). The head
    // `WILD` clears the 4-char ASCII floor from issue #11, but its
    // immediate successor `BLUEのわぶっていきましょう!` ALSO leads with
    // ASCII letters — that's the structural marker for "head is just a
    // brand fragment". Without this guard the head fanout would search
    // TVDB for `WILD` and bind the program to the unrelated 4-char
    // entry `Wild` (tvdb_id 3496). The tail fanout is also suppressed
    // in this shape (intra-brand whitespace, not a show↔prefix
    // boundary).
    const got = searchKeyCandidates('WILD BLUEのわぶっていきましょう!');
    assert.deepEqual(got, ['WILD BLUEのわぶっていきましょう!']);
  });

  test('ASCII head followed by kana is still promoted (negative case for issue #22 guard)', () => {
    // Sibling lock: the issue-#22 guard fires only when the NEXT token
    // also leads with ASCII. A canonical English show name followed by
    // a Japanese subtitle (`Naruto 全話振り返り`-shape) must still fan
    // out to the head — that's the documentary-style fallback the
    // helper exists for. Tail also fans out.
    const got = searchKeyCandidates('Naruto 全話振り返り');
    assert.deepEqual(got, ['Naruto 全話振り返り', 'Naruto', '全話振り返り']);
  });
});

describe('scoreSide — 950 case-insensitive exact tier CJK gate (issue #11)', () => {
  // The 950 tier accepts case-insensitive exact matches (TVDB `Bar` vs
  // EPG key `BAR`). For short pure-ASCII keys this collides with TVDB's
  // generic English entries by sheer casefold (BAR↔Bar, THE↔The,
  // OUR↔Our). The gate requires CJK content OR length > 3 to admit
  // a 950 match — same admissibility principle as the partial-match
  // branches below. Previously this defense lived as a script+length
  // head guard in `searchKeyCandidates`; now it's in the scoring layer
  // where it can evaluate the actual evidence rather than pre-filtering
  // the candidate list.
  const makeSeries = (title: string, titleEn?: string): TvdbEntry => ({
    id: 1,
    slug: 'x',
    title,
    titleEn: titleEn ?? title,
    network: '',
    year: 2026,
    poster: '',
    matchedBy: '',
    type: 'series',
    totalSeasons: 1,
    currentSeason: 1,
    currentEp: 1,
    totalEps: 12,
    status: 'continuing',
  });

  test('rejects: 3-char pure-ASCII key (`BAR` ↔ TVDB `Bar`) → 0', () => {
    const entry = makeSeries('Bar', 'Bar');
    assert.equal(scoreOf(entry, 'BAR'), 0);
  });

  test('rejects: 3-char pure-ASCII key (`THE` ↔ TVDB `The`) → 0', () => {
    const entry = makeSeries('The', 'The');
    assert.equal(scoreOf(entry, 'THE'), 0);
  });

  test('accepts: 4-char pure-ASCII key still admits case-insensitive exact (`LIVE` ↔ TVDB `Live`)', () => {
    // Length > 3 clears the gate. 4-char ASCII is the heuristic edge —
    // `Live` does have its own false-positive surface (#38) but that's
    // handled by the partial-match branches' CJK gate, not the 950 tier.
    const entry = makeSeries('Live', 'Live');
    assert.ok(scoreOf(entry, 'LIVE') >= 950);
  });

  test('accepts: 3-char CJK key passes (`タッチ` ↔ TVDB `タッチ`) — case-sensitive exact tier', () => {
    // Japanese has no case distinction, so the case-sensitive exact
    // (1000) branch fires first. The 950 gate is never reached.
    const entry = makeSeries('タッチ');
    assert.ok(scoreOf(entry, 'タッチ') >= 1000);
  });

  test('accepts: 3-char key with CJK content passes 950 gate', () => {
    // Mixed-script short key with CJK present — gate admits.
    // Synthetic: TVDB `aあ` (case-insensitive twin) vs key `Aあ`.
    const entry = makeSeries('aあ');
    const score = scoreOf(entry, 'Aあ');
    assert.ok(score === 950, `expected 950 (CJK gate admits), got ${score}`);
  });
});

// -------------------------------------------------------------------
// Scoring — `scoreOf` ranks TVDB candidates against a normalized key.
// `normalizeTitle` folds zenkaku punctuation (`？！＃` → `?!#`) on the
// EPG-side key, but TVDB stores the broadcaster's original title so its
// `title` / `titleEn` fields retain the zenkaku form. Without symmetric
// folding, `?` (U+003F) ≠ `？` (U+FF1F) at every comparator and the show
// scores 0. These tests pin down the symmetric fold introduced for
// fix-match issue #5 (大きい女の子は好きですか？).
// -------------------------------------------------------------------

describe('scoreOf — zenkaku/hankaku punctuation folding', () => {
  // Build a minimal `TvdbEntry` for scoring. `scoreOf` only reads
  // `title` and `titleEn`, but TS needs the discriminated-union shape
  // to be complete.
  function makeSeries(title: string, titleEn?: string): TvdbEntry {
    return {
      id: 1,
      slug: 'x',
      title,
      titleEn: titleEn ?? title,
      network: '',
      year: 2026,
      poster: '',
      matchedBy: '',
      type: 'series',
      totalSeasons: 1,
      currentSeason: 1,
      currentEp: 1,
      totalEps: 12,
      status: 'continuing',
    };
  }

  test('zenkaku ？ in TVDB title vs hankaku ? in normalized key still scores exact', () => {
    // Issue #5: TVDB returns `大きい女の子は好きですか？` (U+FF1F) but the
    // EPG-side normalized key is `大きい女の子は好きですか?` (U+003F).
    // Pre-fix, every comparator failed and the show scored 0.
    const entry = makeSeries('大きい女の子は好きですか？');
    const score = scoreOf(entry, '大きい女の子は好きですか?');
    assert.ok(score >= 1000, `expected exact-match score, got ${score}`);
  });

  test('zenkaku ！ in TVDB title vs hankaku ! in normalized key still scores exact', () => {
    // Same class as above — `！` (U+FF01) vs `!` (U+0021).
    const entry = makeSeries('進撃の巨人！');
    const score = scoreOf(entry, '進撃の巨人!');
    assert.ok(score >= 1000, `expected exact-match score, got ${score}`);
  });

  test('zenkaku digits in TVDB title vs hankaku digits in normalized key still scores exact', () => {
    // `１９９２` (U+FF11..FF14) vs `1992` (ASCII).
    const entry = makeSeries('テスト１９９２');
    const score = scoreOf(entry, 'テスト1992');
    assert.ok(score >= 1000, `expected exact-match score, got ${score}`);
  });

  test('non-matching titles still score 0 after folding', () => {
    // Sanity check — folding does not relax matching to be too lenient.
    const entry = makeSeries('全然違う作品');
    const score = scoreOf(entry, '大きい女の子は好きですか?');
    assert.equal(score, 0);
  });

  test('short generic 3-char TVDB title (`Bar`) does NOT match a long broadcaster title that opens with `BAR …`', () => {
    // Issue #11: programs.id `svc-400181_2026-05-10T12:00:00.000Z`
    // (`BAR レモン・ハート　恋の入門ウイスキー`). Pre-guard, the
    // asymmetric-containment branch (key ⊇ ja|en) of scoreOf would let
    // a 3-char generic English word (`Bar`, tvdb_id 414326) score against
    // a 21-char Japanese broadcaster title because the 3-char string is
    // technically a substring head of the long key. CONTAINMENT_MIN_COVERAGE
    // (=0.25) gates this: 3 / 21 = 0.14 < 0.25 → reject. Locks the floor
    // structurally so future tweaks to the branch can't accidentally
    // re-open the door for short generic English titles.
    const entry = makeSeries('Bar', 'Bar');
    const key = normalizeTitle('BAR レモン・ハート　恋の入門ウイスキー');
    const score = scoreOf(entry, key);
    assert.equal(score, 0);
  });

  test('short generic 4-char ASCII TVDB title (`Live`) does NOT match `Live News イット!` via containment', () => {
    // Issue #38: programs.id `svc-3272402080_2026-05-13T06:45:00.000Z`
    // (`Ｌｉｖｅ　Ｎｅｗｓ　イット！[字]　列島中が大気不安定、…`). The
    // bare-title airings (`Ｌｉｖｅ　Ｎｅｗｓ　イット！[字]`) normalise to
    // `Live News イット!` (16 chars). The asymmetric-containment branch
    // (key ⊇ ja|en) previously scored TVDB id 29334 (movie titled `Live`,
    // 4 chars) at 300 because `Live` is technically a substring of the
    // EPG key AND 4/16 = 0.25 just barely clears the CONTAINMENT_MIN_COVERAGE
    // floor — the broadcaster-side news show then got bound to an
    // unrelated single-word English movie. Same shape as the `Bar`
    // carve-out above, but the EPG key is short enough that the ratio
    // floor alone can't catch it: structural guard rejects pure-ASCII
    // Latin/digit TVDB titles ≤ 6 chars from the containment branch
    // entirely. Legitimate same-name matches still pass via the exact
    // branch (`Live` → `Live`, 1000) or via the searchKeyCandidates
    // head fallback. Source: programs.id svc-3272402080_2026-05-13T06:45:00.000Z.
    const entry = makeSeries('Live', 'Live');
    const bareKey = normalizeTitle('Ｌｉｖｅ　Ｎｅｗｓ　イット！[字]');
    assert.equal(bareKey, 'Live News イット!');
    assert.equal(scoreOf(entry, bareKey), 0);
    // Also lock the full-subtitle airing — the bug report variant.
    const fullKey = normalizeTitle(
      'Ｌｉｖｅ　Ｎｅｗｓ　イット！[字]　列島中が大気不安定、落雷突風ひょうに注意',
    );
    assert.equal(scoreOf(entry, fullKey), 0);
    // Sanity: the same TVDB entry still matches the bare key `Live`
    // exactly — the guard only fires for the containment branch.
    assert.ok(scoreOf(entry, 'Live') >= 950);
  });

  test('zenkaku ： in EPG title vs hankaku ` : ` in TVDB title still scores exact', () => {
    // Issue #21: programs.id `svc-3272402080_2026-05-10T16:25:00.000Z`.
    // EPG broadcasts `ゴーストコンサート：ｍｉｓｓｉｎｇ　Ｓｏｎｇｓ　＃０６`
    // — fully zenkaku, with `：` (U+FF1A) between show name and subtitle
    // and no surrounding space. TVDB stores the canonical title as
    // `ゴーストコンサート : missing Songs` (hankaku ` : ` with spaces).
    // Pre-fix: zenkakuToHankaku didn't fold `：`, and even after a
    // hypothetical fold the two sides differ in spacing around `:`,
    // so every comparator failed and the show scored 0. The fold + the
    // symmetric `\s*:\s*` → `:` collapse in scoreOf neutralise the whole
    // class of broadcaster vs TVDB colon-spacing drift.
    const entry = makeSeries('ゴーストコンサート : missing Songs');
    const key = normalizeTitle('ゴーストコンサート：ｍｉｓｓｉｎｇ　Ｓｏｎｇｓ　＃０６');
    const score = scoreOf(entry, key);
    assert.ok(score >= 1000, `expected exact-match score, got ${score}`);
  });

  test('TVDB title carrying an embedded ＜LATIN＞ alias tag still scores exact against the EPG key', () => {
    // Issue #31: programs.id `svc-400141_2026-05-14T15:30:00.000Z`
    // (`牙狼＜GARO＞ -魔戒ノ花-　第７話「神話」`). TVDB stores the
    // canonical title as `牙狼＜GARO＞-魔戒ノ花-` (alias-reading baked
    // directly into the name). `normalizeTitle` strips `＜...＞` on
    // the EPG side via ANGLE_TAG_RE, leaving `牙狼 -魔戒ノ花-` (with
    // residual whitespace from the strip). Pre-fix the TVDB-side
    // title kept the angle tag, so the two keys collided on every
    // comparator. Symmetric `＜...＞` stripping + whitespace-compact
    // on the scoreOf side lines both forms up to the same canonical
    // `牙狼 -魔戒ノ花-` and the show scores exact.
    const entry = makeSeries('牙狼＜GARO＞-魔戒ノ花-', 'GARO: Makai No Hana');
    const key = normalizeTitle('牙狼＜GARO＞ -魔戒ノ花-　第７話「神話」');
    const score = scoreOf(entry, key);
    assert.ok(score >= 1000, `expected exact-match score, got ${score}`);
  });

  test('franchise head-fallback matches a TVDB title that opens with `<key> <published subtitle>` even when the subtitle balloons the length ratio', () => {
    // Issue #33: programs.id `svc-3272502088_2026-05-16T08:30:00.000Z`
    // (`本好きの下剋上　領主の養女　第六章「フェシュピールコンサート」[字][デ]`).
    // `normalizeTitle` reduces the EPG title to
    // `本好きの下剋上 領主の養女` (the arc subtitle survives because
    // it's a real published phrase, not structural noise). The head-
    // fallback in `searchKeyCandidates` then offers `本好きの下剋上`
    // (the franchise root) as the secondary search key, which TVDB
    // returns as series 366263 with the canonical Japanese title
    // `本好きの下剋上 司書になるためには手段を選んでいられません`.
    // Pre-fix: ja.length (29) / key.length (7) = 4.14 > 1.4 →
    // `startsWith` branch rejected and the show scored 0, leaving the
    // program unmatched. The structural-boundary relaxation accepts
    // `ja.startsWith(key)` when the next char of `ja` is a published-
    // subtitle delimiter (whitespace here), so the franchise head
    // resolves and the program inherits the right tvdb_id. Sibling
    // shape of the colon-boundary case (`ゴーストコンサート : missing
    // Songs`) and the tilde-boundary case (`<show> ～<subtitle>～`).
    const entry = makeSeries(
      '本好きの下剋上 司書になるためには手段を選んでいられません',
      'Ascendance of a Bookworm',
    );
    const score = scoreOf(entry, '本好きの下剋上');
    assert.ok(score > 0, `expected non-zero score for franchise head fallback, got ${score}`);
  });

  test('franchise head-fallback rejects when the boundary char is NOT a structural delimiter', () => {
    // Sanity check for the structural-boundary gate: when the TVDB
    // title is a longer kanji/kana compound that just happens to share
    // a 4-char prefix with the EPG key (no delimiter at the boundary),
    // the relaxation MUST NOT fire — that's the regression class the
    // ratio floor was originally protecting against. Example: a key
    // `あいうえ` against a TVDB title `あいうえおかきくけこ` (no
    // delimiter between `え` and `お`) is a coincidental prefix, not a
    // franchise-subtitle pattern.
    const entry = makeSeries('あいうえおかきくけこさしすせそ');
    const score = scoreOf(entry, 'あいうえ');
    assert.equal(score, 0);
  });

  test('franchise head-fallback rejects pure-ASCII key against longer TVDB title (issue #40: `The Hit` must not match `The Hit List`)', () => {
    // Issue #40: programs.id `svc-3208643056_2026-05-13T13:00:00.000Z`
    // (`Ｔｈｅ　Ｈｉｔ`, a Japanese sportfishing show on a JCOM/SunTV-
    // class local broadcaster, ARIB genre `edu`). `normalizeTitle`
    // reduces the EPG title to `The Hit` (7 chars, pure ASCII).
    // `pickBest`'s movie-genre gate correctly rejects TVDB id 11907
    // (`The Hit`, 1984 British film, `kind: 'movie'`) because no
    // program in the cohort is tagged 映画. But on the next search,
    // TVDB returns series 364620 (`The Hit List`, BBC 2019, `kind:
    // 'series'`) and the structural-boundary franchise-head relaxation
    // accepts the bind: `ja.startsWith('The Hit')` ✓, next char is ` `
    // (structural delimiter) ✓ → score 638. Pre-fix the cohort got
    // bound to an unrelated UK quiz series.
    //
    // The franchise-head relaxation is structurally a CJK-rooted
    // pattern (broadcaster appends a Japanese arc subtitle after the
    // canonical franchise root). For pure-ASCII keys the broadcaster
    // sends the FULL canonical TVDB title (the brand is the name), so
    // legitimate ASCII same-name matches like `Suits` → `Suits` bind
    // via the exact-match branch above (score 1000) and don't depend
    // on this relaxation at all. Gating the relaxation to keys with at
    // least one CJK char closes the ASCII false-positive class without
    // affecting the CJK success cases that motivated issue #33.
    const entry = makeSeries('The Hit List', 'The Hit List');
    const score = scoreOf(entry, 'The Hit');
    assert.equal(score, 0);
  });

  test('franchise head-fallback still accepts CJK key against longer TVDB title (issue #33 — negative regression for the ASCII guard)', () => {
    // Sanity check for the keyHasCjk gate added in issue #40: the
    // original issue-#33 case (`本好きの下剋上` → TVDB `本好きの下剋上
    // 司書になるためには手段を選んでいられません`) must still pass —
    // the CJK franchise root is the structural shape the relaxation
    // was built for.
    const entry = makeSeries(
      '本好きの下剋上 司書になるためには手段を選んでいられません',
      'Ascendance of a Bookworm',
    );
    const score = scoreOf(entry, '本好きの下剋上');
    assert.ok(score > 0, `expected non-zero score, got ${score}`);
  });

  test('script-variant tail: TVDB stores katakana brand suffix while EPG uses ASCII Latin', () => {
    // Issue #37: programs.id `svc-400211_2026-05-12T16:00:00.000Z`
    // (`こめかみっ！Girls　＃６「トマトまるごとパエリア」`).
    // `normalizeTitle` reduces the EPG title to `こめかみっ!Girls`.
    // TVDB stores the official Japanese form as `こめかみっ! ガールズ`
    // (series 476071). Pre-fix every comparator failed because the
    // shared CJK prefix `こめかみっ!` is followed by script-disjoint
    // tails (ASCII `Girls` vs katakana `ガールズ`), so `ja.startsWith(key)`
    // and `key.includes(ja)` all returned false. The script-variant
    // tail relaxation accepts this exact structural shape: shared
    // CJK prefix (≥ 4 kana/kanji chars) ending at `!`/`?`, and the
    // divergent tails are one pure ASCII Latin and one pure katakana
    // — no possibility of partial-text collision with an unrelated
    // entry.
    const entry = makeSeries('こめかみっ! ガールズ');
    const score = scoreOf(entry, 'こめかみっ!Girls');
    assert.ok(score > 0, `expected non-zero score for script-variant tail, got ${score}`);
  });

  test('script-variant tail: rejects when shared CJK prefix is too short (< 4 kana/kanji)', () => {
    // Sanity gate: a 2-char CJK prefix (`こめ`) is too short to be a
    // distinctive franchise root, so the script-variant relaxation
    // MUST NOT fire even when the tails are script-disjoint. Protects
    // against generic short-prefix collisions.
    const entry = makeSeries('こめ! ガールズ');
    const score = scoreOf(entry, 'こめ!Girls');
    assert.equal(score, 0);
  });

  test('script-variant tail: rejects when tail lengths differ by more than 1.8x', () => {
    // Sanity gate: a 5-char Latin tail can't anchor a 20-char katakana
    // tail. Protects against a short brand suffix being matched against
    // a much longer published subtitle that happens to be all katakana.
    const entry = makeSeries('こめかみっ! ガールズアンドバンドサウンドプロジェクト');
    const score = scoreOf(entry, 'こめかみっ!Girls');
    assert.equal(score, 0);
  });

  test('script-variant tail: rejects when tail scripts overlap (not script-disjoint)', () => {
    // Sanity gate: when the TVDB tail mixes katakana + Latin or has
    // any non-katakana CJK, the structural promise (one pure Latin,
    // one pure katakana) breaks and the branch MUST NOT fire.
    const entry = makeSeries('こめかみっ! ガール子');
    const score = scoreOf(entry, 'こめかみっ!Girls');
    assert.equal(score, 0);
  });
});

describe('isAutoOverrideValidForCohort — gate auto-override replay against the cohort movie signal', () => {
  // Issue #40: programs.id `svc-3208643056_2026-05-13T13:00:00.000Z`
  // (`Ｔｈｅ　Ｈｉｔ`, ARIB genre `edu` — a Japanese sportfishing show).
  // The bare normalized key `The Hit` collided with TVDB id 11907
  // (`The Hit`, 1984 British film, `kind: 'movie'`). `pickBest` already
  // gates movie candidates when no program in the cohort is tagged
  // genre `映画`, but `enrichUnmatched`'s auto-override replay path
  // re-applied the previously-pinned tvdb_id for 30 days WITHOUT re-
  // running that gate. This validator re-applies the gate on replay so
  // a stale movie-pinned override heals automatically on the next pass
  // (the call site falls through to fresh re-resolution, which now
  // correctly returns "no match" for the Japanese fishing show).
  test('rejects replay when pinned entry is `movie` and cohort has no movie genre', () => {
    assert.equal(isAutoOverrideValidForCohort('movie', false), false);
  });

  test('accepts replay when pinned entry is `movie` and cohort DOES have a movie-tagged airing', () => {
    // Mixed cohort: at least one program tagged genre 映画 means the
    // movie-type candidate is structurally legitimate. Same shape as
    // `pickBest`'s `allowMovie=true` branch.
    assert.equal(isAutoOverrideValidForCohort('movie', true), true);
  });

  test('accepts replay when pinned entry is `series` regardless of cohort movie signal', () => {
    // Series-type overrides are not affected by this gate — they always
    // pass. This is the "Naruto-class" carve-out: a short pure-ASCII
    // exact-match to a TV series stays bound on subsequent replays.
    assert.equal(isAutoOverrideValidForCohort('series', false), true);
    assert.equal(isAutoOverrideValidForCohort('series', true), true);
  });

  test('accepts replay when pinned entry kind is unknown (cache miss)', () => {
    // If the cached tvdb_entries row is missing (override pre-dates the
    // cache, or the row was deleted), we don't have the kind signal —
    // don't drop the override on a guess, fall through to the regular
    // TTL-based path so the override naturally re-resolves at 30d.
    assert.equal(isAutoOverrideValidForCohort(undefined, false), true);
    assert.equal(isAutoOverrideValidForCohort(null, false), true);
  });
});

describe('suggestRuleKeyword — schedule-hit-based candidate picking', () => {
  test('Ｎスタ型: [字]　 直後のサブタイ込み候補は1件しか当たらないので短い「Ｎスタ」を選ぶ', () => {
    const schedule = [
      'Ｎスタ[字]　最新中東情勢▽ハンタウイルス感染船',
      'Ｎスタ[字]　明日のニュース▽天気',
      'Ｎスタ[字]　経済特集',
      'Ｎスタ[字]',
      '別の番組',
    ];
    assert.equal(
      suggestRuleKeyword('Ｎスタ[字]　最新中東情勢▽ハンタウイルス感染船', schedule),
      'Ｎスタ',
    );
  });

  test('週次番組: 完全タイトルが2件以上当たればそのまま採用 (フル長 > 短縮)', () => {
    const schedule = [
      'プロフェッショナル　仕事の流儀「ある町工場の物語」',
      'プロフェッショナル　仕事の流儀「料理人の挑戦」',
      'プロフェッショナル　仕事の流儀「医師の決断」',
    ];
    assert.equal(
      suggestRuleKeyword('プロフェッショナル　仕事の流儀「ある町工場の物語」', schedule),
      'プロフェッショナル　仕事の流儀',
    );
  });

  test('「」サブタイトルで切る (あさイチ型)', () => {
    const schedule = [
      'あさイチ「特集 ○○」',
      'あさイチ「特集 △△」',
      'あさイチ「ゲスト出演」',
    ];
    assert.equal(
      suggestRuleKeyword('あさイチ「特集 ○○」', schedule),
      'あさイチ',
    );
  });

  test('連続メタタグ [字][デ]　… も切れる', () => {
    const schedule = [
      '黒猫と魔女の教室[字][デ]　＃０５「スピカとアリア」',
      '黒猫と魔女の教室[字][デ]　＃０６',
      '黒猫と魔女の教室[字][デ]　＃０７',
    ];
    assert.equal(
      suggestRuleKeyword('黒猫と魔女の教室[字][デ]　＃０５「スピカとアリア」', schedule),
      '黒猫と魔女の教室',
    );
  });

  test('schedule にこの回しか無い: 最短 (=最アグレッシブな) 候補にフォールバック', () => {
    const schedule = ['Ｎスタ[字]　最新中東情勢▽ハンタウイルス感染船'];
    assert.equal(
      suggestRuleKeyword('Ｎスタ[字]　最新中東情勢▽ハンタウイルス感染船', schedule),
      'Ｎスタ',
    );
  });

  test('区切りが無く schedule に複数ある: フルタイトル採用', () => {
    const schedule = ['ＮＨＫニュース７', 'ＮＨＫニュース７', 'ＮＨＫニュース９'];
    assert.equal(
      suggestRuleKeyword('ＮＨＫニュース７', schedule),
      'ＮＨＫニュース７',
    );
  });

  test('末尾メタタグは見栄え除去 (ヒルナンデス！[字])', () => {
    const schedule = ['ヒルナンデス！[字]', 'ヒルナンデス！[字]'];
    assert.equal(
      suggestRuleKeyword('ヒルナンデス！[字]', schedule),
      'ヒルナンデス！',
    );
  });

  test('zenkaku #N (＃０５) 形式の話数マーカーで切れる', () => {
    const schedule = ['アニメA・あかね噺　＃６', 'アニメA・あかね噺　＃７'];
    assert.equal(
      suggestRuleKeyword('アニメA・あかね噺　＃６', schedule),
      'アニメA・あかね噺',
    );
  });
});
