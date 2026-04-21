import type { Program } from '../src/schemas/program.ts';
import { GENRES as G } from './genres.ts';
import { at } from './baseDate.ts';

interface Row {
  ch: string;
  start: string;
  end: string;
  title: string;
  genre: keyof typeof G;
  ep?: string;
  series?: string;
  hd?: boolean;
}

const rows: Row[] = [
  // NHK 総合
  { ch:'nhk-g', start:'17:00', end:'17:30', title:'ダーウィンが来た!「ライチョウ親子の春」', genre:'DOC', ep:'#742', series:'darwin' },
  { ch:'nhk-g', start:'18:10', end:'18:45', title:'これでわかった!世界のいま', genre:'NEWS', series:'sekai-ima' },
  { ch:'nhk-g', start:'19:00', end:'19:30', title:'NHKニュース7', genre:'NEWS', series:'news7' },
  { ch:'nhk-g', start:'19:30', end:'20:00', title:'所さん!事件ですよ', genre:'INFO', ep:'#208', series:'tokoro-jiken' },
  { ch:'nhk-g', start:'20:00', end:'20:45', title:'大河ドラマ「風の群像」第16回', genre:'DRAMA', ep:'#16', series:'taiga-2026' },
  { ch:'nhk-g', start:'21:00', end:'21:50', title:'NHKスペシャル 「AIと働く未来」', genre:'DOC', ep:'#2025', series:'nhk-special' },
  { ch:'nhk-g', start:'23:10', end:'23:40', title:'ドキュメント72時間 「夜桜の駅前喫茶」', genre:'DOC', ep:'#608', series:'doc72h' },

  // NHK E
  { ch:'nhk-e', start:'19:25', end:'19:55', title:'ワイルドライフ', genre:'DOC', series:'wildlife' },
  { ch:'nhk-e', start:'19:55', end:'20:45', title:'日曜美術館 「若冲と江戸の花」', genre:'DOC', ep:'#1542', series:'nichiyo-bijutsu' },
  { ch:'nhk-e', start:'21:00', end:'22:00', title:'クラシック音楽館 「ブラームス 交響曲第1番」', genre:'MUSIC', series:'classic-kan' },
  { ch:'nhk-e', start:'22:00', end:'23:00', title:'ETV特集 「原爆と沈黙の80年」', genre:'DOC', ep:'#624', series:'etv-special' },

  // 日テレ
  { ch:'ntv', start:'14:00', end:'15:55', title:'映画「カメラを止めるな!」(2018)', genre:'MOVIE', hd:true },
  { ch:'ntv', start:'18:00', end:'18:55', title:'イッテQ!日曜スペシャル', genre:'VAR', ep:'#731', series:'itteq' },
  { ch:'ntv', start:'19:58', end:'20:54', title:'世界の果てまでイッテQ!', genre:'VAR', ep:'#731', series:'itteq' },
  { ch:'ntv', start:'21:00', end:'22:00', title:'行列のできる相談所', genre:'VAR', series:'gyoretsu' },

  // テレビ朝日
  { ch:'ex', start:'09:30', end:'10:00', title:'プリキュア', genre:'ANIME', ep:'#612', series:'precure' },
  { ch:'ex', start:'13:55', end:'16:20', title:'日曜洋画劇場「ショーシャンクの空に」', genre:'MOVIE', series:'shawshank', hd:true },
  { ch:'ex', start:'17:55', end:'18:55', title:'ポツンと一軒家', genre:'DOC', ep:'#312', series:'potsun' },

  // TBS
  { ch:'tbs', start:'16:00', end:'17:30', title:'世界遺産 「ドロミーティ」', genre:'DOC', ep:'#1325', series:'sekai-isan' },
  { ch:'tbs', start:'17:59', end:'18:55', title:'バナナマンのせっかくグルメ!!', genre:'VAR', ep:'#410', series:'sekkaku' },
  { ch:'tbs', start:'21:00', end:'22:00', title:'日曜劇場「春を待つ手紙」第2話', genre:'DRAMA', ep:'#02', series:'nichigeki-2026q2' },
  { ch:'tbs', start:'22:00', end:'22:54', title:'情熱大陸', genre:'DOC', ep:'#1288', series:'jonetsu' },

  // テレビ東京
  { ch:'tx', start:'07:30', end:'08:30', title:'ポケットモンスター', genre:'ANIME', ep:'#1281', series:'pokemon' },
  { ch:'tx', start:'17:30', end:'18:30', title:'新美の巨人たち', genre:'DOC', ep:'#824', series:'bi-no-kyojin' },
  { ch:'tx', start:'19:54', end:'20:54', title:'和風総本家', genre:'DOC', ep:'#712', series:'wafu-sohonke' },

  // フジ
  { ch:'cx', start:'18:00', end:'18:30', title:'ちびまる子ちゃん', genre:'ANIME', ep:'#1524', series:'maruko' },
  { ch:'cx', start:'18:30', end:'19:00', title:'サザエさん', genre:'ANIME', ep:'#2931', series:'sazae' },
  { ch:'cx', start:'21:00', end:'23:10', title:'日曜劇場「桜と羅針盤」(映画)', genre:'MOVIE', hd:true },

  // TOKYO MX
  { ch:'mx', start:'18:00', end:'19:00', title:'アニメ「響け!ユーフォニアム」', genre:'ANIME', ep:'#09', series:'euph-2026' },
  { ch:'mx', start:'19:00', end:'20:00', title:'アニメ「怪獣8号」第2期', genre:'ANIME', ep:'#11', series:'kaiju8' },

  // NHK BS
  { ch:'bs1', start:'07:00', end:'11:00', title:'MLB 大谷翔平出場試合中継', genre:'SPORT', series:'mlb', hd:true },
  { ch:'bs1', start:'22:00', end:'23:00', title:'アナザーストーリーズ', genre:'DOC', ep:'#218', series:'another-story' },

  // BSP
  { ch:'bsp', start:'11:00', end:'13:00', title:'BSシネマ「となりのトトロ」', genre:'MOVIE', series:'tonari-totoro', hd:true },
  { ch:'bsp', start:'19:00', end:'21:00', title:'BS時代劇「鬼平犯科帳」特別編', genre:'DRAMA', series:'onihei' },
];

export const PROGRAMS: Program[] = rows.map<Program>((r) => {
  const startAt = at(r.start);
  return {
    id: `${r.ch}_${startAt}`,
    ch: r.ch,
    startAt,
    endAt: at(r.end),
    title: r.title,
    genre: G[r.genre],
    ep: r.ep ?? null,
    series: r.series ?? null,
    hd: r.hd,
  };
});
