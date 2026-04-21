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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle } from './matchService.ts';

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
    expected: '無職転生Ⅱ ～異世界行ったら本気だす～',
    note: '第五話 (kanji digit) stripped',
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
    raw: 'ＬａＬａ　ＴＶ「コンコンパッパッ～今日から芸農人！～」＃１　［字］',
    expected: 'LaLa TV',
    note: 'LaLa TV is not a known block prefix so the quoted content is treated as an episode subtitle and stripped. This keeps TVDB searching on "LaLa TV" which is safer than a weekly show name.',
  },
  {
    raw: '[字]Fresh　Faces　＃550 木下こづえ、木下さとみ',
    expected: 'Fresh Faces',
    note: 'cut at #550 takes out everything after, including the guest list',
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
