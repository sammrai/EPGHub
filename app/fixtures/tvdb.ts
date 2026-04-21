// Dev-only fixture data. Do NOT import from src/ at runtime.
import type { NowRecording, Recorded, Rule, TvdbEntry } from '../src/data/types';
import { RULES } from './programs';

export const TVDB: Record<string, TvdbEntry> = {
  'taiga-2026':       { type:'series', id: 389042, slug:'kaze-no-gunzo',     title:'風の群像',        titleEn:'Kaze no Gunzō',       network:'NHK',  year:2026, totalSeasons:1, currentSeason:1, currentEp:16, totalEps:47, status:'continuing', poster:'poster-taiga',       matchedBy:'タイトル完全一致' },
  'nichigeki-2026q2': { type:'series', id: 412788, slug:'haru-wo-matsu-tegami', title:'春を待つ手紙',   titleEn:'Letters Awaiting Spring', network:'TBS', year:2026, totalSeasons:1, currentSeason:1, currentEp:2, totalEps:10, status:'continuing', poster:'poster-haru',        matchedBy:'タイトル完全一致' },
  'darwin':           { type:'series', id: 82118,  slug:'darwins-amazing-animals', title:'ダーウィンが来た!', titleEn:"Darwin's Amazing Animals", network:'NHK', year:2006, totalSeasons:20, currentSeason:20, currentEp:742, totalEps:742, status:'continuing', poster:'poster-darwin', matchedBy:'シリーズ名一致' },
  'nhk-special':      { type:'series', id: 79214,  slug:'nhk-special',       title:'NHKスペシャル',     titleEn:'NHK Special',         network:'NHK',  year:1989, totalSeasons:37, currentSeason:37, currentEp:2025, totalEps:2025, status:'continuing', poster:'poster-nhksp', matchedBy:'シリーズ名一致' },
  'doc72h':           { type:'series', id: 258166, slug:'document-72-hours', title:'ドキュメント72時間', titleEn:'Document 72 Hours',   network:'NHK',  year:2013, totalSeasons:12, currentSeason:12, currentEp:608, totalEps:608, status:'continuing', poster:'poster-72h', matchedBy:'タイトル完全一致' },
  'itteq':            { type:'series', id: 97221,  slug:'itteq',             title:'世界の果てまでイッテQ!', titleEn:'Sekai no Hate made IttekyuQ!', network:'NTV', year:2007, totalSeasons:18, currentSeason:18, currentEp:731, totalEps:731, status:'continuing', poster:'poster-itteq', matchedBy:'シリーズ名一致' },
  'sazae':            { type:'series', id: 74917,  slug:'sazae-san',         title:'サザエさん',        titleEn:'Sazae-san',            network:'CX',   year:1969, totalSeasons:57, currentSeason:57, currentEp:2931, totalEps:2931, status:'continuing', poster:'poster-sazae', matchedBy:'タイトル完全一致' },
  'maruko':           { type:'series', id: 77611,  slug:'chibi-maruko-chan', title:'ちびまる子ちゃん',  titleEn:'Chibi Maruko-chan',    network:'CX',   year:1990, totalSeasons:34, currentSeason:34, currentEp:1524, totalEps:1524, status:'continuing', poster:'poster-maruko', matchedBy:'タイトル完全一致' },
  'pokemon':          { type:'series', id: 76703,  slug:'pokemon',           title:'ポケットモンスター', titleEn:'Pokémon',              network:'TX',   year:1997, totalSeasons:26, currentSeason:26, currentEp:1281, totalEps:1281, status:'continuing', poster:'poster-pokemon', matchedBy:'タイトル完全一致' },
  'precure':          { type:'series', id: 79824,  slug:'precure',           title:'プリキュア',        titleEn:'Pretty Cure',          network:'EX',   year:2004, totalSeasons:21, currentSeason:21, currentEp:612, totalEps:612, status:'continuing', poster:'poster-precure', matchedBy:'シリーズ名一致' },
  'euph-2026':        { type:'series', id: 295068, slug:'hibike-euphonium',  title:'響け!ユーフォニアム', titleEn:'Sound! Euphonium',  network:'MX',   year:2015, totalSeasons:4, currentSeason:4, currentEp:9, totalEps:13, status:'continuing', poster:'poster-euph', matchedBy:'タイトル完全一致' },
  'kaiju8':           { type:'series', id: 428052, slug:'kaiju-no-8',        title:'怪獣8号',           titleEn:'Kaiju No. 8',          network:'MX',   year:2024, totalSeasons:2, currentSeason:2, currentEp:11, totalEps:12, status:'continuing', poster:'poster-kaiju8', matchedBy:'タイトル完全一致' },
  'sekai-isan':       { type:'series', id: 84215,  slug:'sekai-isan',        title:'世界遺産',          titleEn:'The World Heritage',    network:'TBS',  year:1996, totalSeasons:29, currentSeason:29, currentEp:1325, totalEps:1325, status:'continuing', poster:'poster-sekai', matchedBy:'タイトル完全一致' },
  'jonetsu':          { type:'series', id: 86011,  slug:'jonetsu-tairiku',   title:'情熱大陸',          titleEn:'Jonetsu Tairiku',       network:'TBS',  year:1998, totalSeasons:27, currentSeason:27, currentEp:1288, totalEps:1288, status:'continuing', poster:'poster-jonetsu', matchedBy:'シリーズ名一致' },
  'potsun':           { type:'series', id: 342117, slug:'potsun-to-ikken-ya', title:'ポツンと一軒家',   titleEn:'A Lone House in the Middle of Nowhere', network:'EX', year:2018, totalSeasons:8, currentSeason:8, currentEp:312, totalEps:312, status:'continuing', poster:'poster-potsun', matchedBy:'タイトル完全一致' },
  'sci-zero':         { type:'series', id: 83612,  slug:'science-zero',      title:'サイエンスZERO',    titleEn:'Science Zero',          network:'NHK',  year:2003, totalSeasons:23, currentSeason:23, currentEp:812, totalEps:812, status:'continuing', poster:'poster-scizero', matchedBy:'タイトル完全一致' },
  'shawshank':        { type:'movie',  id: 111161, slug:'the-shawshank-redemption', title:'ショーシャンクの空に', titleEn:'The Shawshank Redemption', network:'TX', year:1994, runtime:142, director:'Frank Darabont', rating:9.3, poster:'poster-shawshank', matchedBy:'タイトル完全一致' },
  'spirited':         { type:'movie',  id: 245712, slug:'spirited-away',     title:'千と千尋の神隠し',  titleEn:'Spirited Away',         network:'NTV',  year:2001, runtime:125, director:'宮崎駿',      rating:8.6, poster:'poster-spirited', matchedBy:'タイトル完全一致' },
  'tonari-totoro':    { type:'movie',  id: 96283,  slug:'my-neighbor-totoro', title:'となりのトトロ',  titleEn:'My Neighbor Totoro',    network:'NTV',  year:1988, runtime:86,  director:'宮崎駿',      rating:8.2, poster:'poster-totoro', matchedBy:'タイトル完全一致' },
};

export const RECORDED: Recorded[] = [
  { id:'r1',  tvdbId:389042, series:'taiga-2026',  season:1, ep:15,  title:'風の群像',      epTitle:'春風の約束',       ch:'nhk-g', air:'2026/04/12 (日) 20:00', duration:45,  size:4.1,  quality:'1080i', filename:'Kaze.no.Gunzo.S01E15.Haru.Kaze.no.Yakusoku.1080i.mkv', thumb:'t-taiga-15', new:true, state:'encoding', encodeProgress:0.42, encodePreset:'H.265 1080p' },
  { id:'r2',  tvdbId:389042, series:'taiga-2026',  season:1, ep:14,  title:'風の群像',      epTitle:'桜の下で',         ch:'nhk-g', air:'2026/04/05 (日) 20:00', duration:45,  size:4.0,  quality:'1080i', filename:'Kaze.no.Gunzo.S01E14.Sakura.no.Shita.de.1080i.mkv', thumb:'t-taiga-14', state:'queued', encodePreset:'H.265 1080p' },
  { id:'r3',  tvdbId:97221,  series:'itteq',       season:18,ep:730, title:'世界の果てまでイッテQ!', epTitle:'アマゾン奥地の民族', ch:'ntv',   air:'2026/04/12 (日) 19:58', duration:54,  size:5.2,  quality:'1080i', filename:'IttekyuQ.S18E730.Amazon.Okuchi.1080i.mkv', thumb:'t-itteq-730', state:'ready' },
  { id:'r4',  tvdbId:74917,  series:'sazae',       season:57,ep:2930,title:'サザエさん',    epTitle:'カツオの春休み',    ch:'cx',    air:'2026/04/12 (日) 18:30', duration:24,  size:1.4,  quality:'720p',  filename:'Sazae.san.S57E2930.Katsuo.no.Haruyasumi.720p.mkv', thumb:'t-sazae', state:'ready' },
  { id:'r5',  tvdbId:295068, series:'euph-2026',   season:4, ep:8,   title:'響け!ユーフォニアム', epTitle:'コンクール前夜', ch:'mx',    air:'2026/04/12 (日) 18:00', duration:24,  size:1.8,  quality:'1080i', filename:'Hibike.Euphonium.S04E08.Concour.Zenya.1080i.mkv', thumb:'t-euph', new:true, state:'ready' },
  { id:'r6',  tvdbId:79214,  series:'nhk-special', season:37,ep:2024,title:'NHKスペシャル', epTitle:'戦後80年 証言の記憶', ch:'nhk-g', air:'2026/04/13 (月) 22:00', duration:50,  size:4.6,  quality:'1080i', filename:'NHK.Special.S37E2024.Sengo80.1080i.mkv', thumb:'t-nhksp', state:'ready' },
  { id:'r7',  tvdbId:null,   series:null,          season:null, ep:null, title:'プロ野球 「巨人×阪神」', epTitle:null,      ch:'nhk-g', air:'2026/04/13 (月) 18:00', duration:180, size:16.4, quality:'1080i', filename:'2026-04-13_18-00_NHK.G_Pro.Yakyu.1080i.mkv', thumb:'t-baseball', ruleMatched:null, state:'ready' },
  { id:'r8',  tvdbId:258166, series:'doc72h',      season:12,ep:607, title:'ドキュメント72時間', epTitle:'渋谷スクランブル交差点', ch:'nhk-g', air:'2026/04/04 (金) 22:45', duration:30,  size:2.8, quality:'1080i', filename:'Document.72h.S12E607.Shibuya.Scramble.1080i.mkv', thumb:'t-72h', new:true, state:'ready' },
  { id:'r9',  tvdbId:428052, series:'kaiju8',      season:2, ep:10,  title:'怪獣8号',       epTitle:'鳴り響く号令',     ch:'mx',    air:'2026/04/12 (日) 19:00', duration:24,  size:1.9,  quality:'1080i', filename:'Kaiju.No.8.S02E10.Nari.hibiku.Gorei.1080i.mkv', thumb:'t-kaiju8', state:'ready' },
  { id:'r10', tvdbId:82118,  series:'darwin',      season:20,ep:741, title:'ダーウィンが来た!', epTitle:'ニホンザルの春',   ch:'nhk-g', air:'2026/04/12 (日) 17:00', duration:30,  size:2.5,  quality:'1080i', filename:'Darwin.ga.Kita.S20E741.Nihonzaru.1080i.mkv', thumb:'t-darwin', state:'ready' },
  { id:'r11', tvdbId:84215,  series:'sekai-isan',  season:29,ep:1324,title:'世界遺産',      epTitle:'マチュピチュ再訪', ch:'tbs',   air:'2026/04/12 (日) 16:00', duration:30,  size:2.4,  quality:'1080i', filename:'Sekai.Isan.S29E1324.Machu.Picchu.1080i.mkv', thumb:'t-sekai', state:'ready' },
  { id:'r12', tvdbId:111161, series:'shawshank', season:null, ep:null, title:'映画「ショーシャンクの空に」', epTitle:null, ch:'tx', air:'2026/04/11 (土) 21:00', duration:142, size:11.2, quality:'1080i', filename:'The.Shawshank.Redemption.1994.1080i.mkv', thumb:'t-shawshank', state:'ready' },
  { id:'r13', tvdbId:86011,  series:'jonetsu',     season:27,ep:1287,title:'情熱大陸',      epTitle:'建築家 隈研吾',    ch:'tbs',   air:'2026/04/12 (日) 22:00', duration:30,  size:2.7,  quality:'1080i', filename:'Jonetsu.Tairiku.S27E1287.Kuma.Kengo.1080i.mkv', thumb:'t-jonetsu', state:'ready' },
  { id:'r14', tvdbId:342117, series:'potsun',      season:8, ep:311, title:'ポツンと一軒家', epTitle:'長野・北信濃の山奥',ch:'ex',    air:'2026/04/12 (日) 17:55', duration:60,  size:5.4,  quality:'1080i', filename:'Potsun.to.Ikken.ya.S08E311.Nagano.1080i.mkv', thumb:'t-potsun', state:'ready' },
  { id:'r15', tvdbId:null,   series:null, season:null, ep:null, title:'プロ野球ニュース', epTitle:null, ch:'cx', air:'2026/04/18 (土) 23:40', duration:30,  size:2.6, quality:'1080i', filename:'2026-04-18_23-40_CX_Pro.Yakyu.News.1080i.mkv', thumb:'t-prnews', ruleMatched:'プロ野球', state:'ready' },
  { id:'r16', tvdbId:245712, series:'spirited',  season:null, ep:null, title:'金曜ロードショー「千と千尋の神隠し」', epTitle:null, ch:'ntv', air:'2026/03/28 (金) 21:00', duration:125, size:9.8, quality:'1080i', filename:'Spirited.Away.2001.1080i.mkv', thumb:'t-spirited', state:'ready' },
  { id:'r17', tvdbId:96283,  series:'tonari-totoro', season:null, ep:null, title:'金曜ロードショー「となりのトトロ」', epTitle:null, ch:'ntv', air:'2026/02/14 (金) 21:00', duration:86, size:6.7, quality:'1080i', filename:'My.Neighbor.Totoro.1988.1080i.mkv', thumb:'t-totoro', state:'ready' },
];

export const NOW_RECORDING: NowRecording[] = [
  { id:'nr1', title:'大相撲春巡業 中継', ch:'nhk-g', start:'17:00', end:'18:00', progress:0.72, series:null, tvdbId:null },
];

export function linkRulesToTvdb(rules: Rule[]): Rule[] {
  return rules.map((r) => {
    const match = Object.values(TVDB).find(
      (t) => t.type !== 'movie' && (r.keyword.includes(t.title) || r.name.includes(t.title))
    );
    if (match) return { ...r, tvdb: match, kind: 'series' };
    return { ...r, kind: 'keyword' };
  });
}

export const LINKED_RULES: Rule[] = linkRulesToTvdb(RULES);
