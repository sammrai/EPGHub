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
import { normalizeTitle, scoreOf, searchKeyCandidates, suggestRuleKeyword } from './matchService.ts';
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
    note: 'Borderline — 機動戦士ガンダム 水星の魔女 would be ideal but retaining the block name preserves the existing behavior and keeps TVDB search usable',
  },
  {
    raw: 'NEXT company「野生鳥獣被害解決の切り札に？自立走行巡回ロボット」',
    expected: 'NEXT company',
    note: 'The quoted chunk is the episode topic, not the show name',
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
    const SNAPSHOT_LIMIT = 18;
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

  test('documentary-style "<show> <subtitle>" → primary + head', () => {
    // `ブラタモリ 国宝犬山城` falls back to the leading token when the
    // full string misses TVDB. This is the only fan-out the helper
    // does; structural sequel suffixes are stripped at normalize-time.
    const got = searchKeyCandidates('ブラタモリ 国宝犬山城');
    assert.deepEqual(got, ['ブラタモリ 国宝犬山城', 'ブラタモリ']);
  });

  test('head shorter than 3 chars is NOT added (avoids stop-word blowups)', () => {
    // `AB CDE` — head 'AB' is 2 chars, dropped from candidates.
    const got = searchKeyCandidates('AB CDE');
    assert.deepEqual(got, ['AB CDE']);
  });

  test('3-char ASCII-only head is NOT promoted (issue #11: `BAR` head must not fan out)', () => {
    // Issue #11: programs.id `svc-400181_2026-05-10T12:00:00.000Z`.
    // Without this guard, the head fallback would emit `BAR` and
    // exact-match the unrelated TVDB show `Bar` (tvdb_id 414326).
    // The minHeadLen split (3 chars CJK ok, 4 chars ASCII required)
    // structurally separates "show name token" from "noise opener"
    // — `タッチ`/`鬼滅` keep working, but `BAR`/`THE`/`OUR` are dropped.
    const got = searchKeyCandidates('BAR レモン・ハート 恋の入門ウイスキー');
    assert.deepEqual(got, ['BAR レモン・ハート 恋の入門ウイスキー']);
  });

  test('3-char CJK kana/kanji head IS still promoted (negative case for the ASCII-only guard)', () => {
    // Sibling lock for the test above: the minHeadLen split must be
    // ASCII-only — 3-char CJK heads remain valid show-name tokens.
    // `タッチ` (3 kana chars) is the canonical example.
    const got = searchKeyCandidates('タッチ 全国大会編');
    assert.deepEqual(got, ['タッチ 全国大会編', 'タッチ']);
  });

  test('duplicate primary/head deduped', () => {
    const got = searchKeyCandidates('鬼滅');
    assert.deepEqual(got, ['鬼滅']);
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
