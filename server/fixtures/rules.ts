import type { Rule } from '../src/schemas/rule.ts';
import { TVDB_CATALOG } from './tvdb.ts';
import { at } from './baseDate.ts';

const base: Omit<Rule, 'kind' | 'tvdb' | 'ngKeywords' | 'genreDeny' | 'timeRangeDeny'>[] = [
  { id: 1, name:'大河ドラマ 風の群像', keyword:'大河ドラマ 風の群像', channels:['nhk-g'], enabled:true,  matches:12,   nextMatch:{ch:'nhk-g', title:'大河ドラマ「風の群像」第16回', at: at('20:00')}, priority:'high',   quality:'1080i', skipReruns:true },
  { id: 2, name:'日曜劇場',            keyword:'日曜劇場',           channels:['tbs'],   enabled:true,  matches:3,    nextMatch:{ch:'tbs',   title:'日曜劇場「春を待つ手紙」第2話', at: at('21:00')}, priority:'high',   quality:'1080i', skipReruns:true },
  { id: 3, name:'NHKスペシャル',       keyword:'NHKスペシャル',       channels:['nhk-g'], enabled:true,  matches:47,   nextMatch:{ch:'nhk-g', title:'NHKスペシャル 「AIと働く未来」', at: at('21:00')}, priority:'medium', quality:'1080i', skipReruns:false },
  { id: 4, name:'サザエさん',          keyword:'サザエさん',           channels:['cx'],    enabled:true,  matches:2931, nextMatch:{ch:'cx',    title:'サザエさん',                  at: at('18:30')}, priority:'low',    quality:'720p',  skipReruns:true },
  { id: 5, name:'イッテQ (再除外)',    keyword:'イッテQ',             channels:['ntv'],   enabled:true,  matches:731,  nextMatch:{ch:'ntv',   title:'世界の果てまでイッテQ!',      at: at('19:58')}, priority:'medium', quality:'1080i', skipReruns:true },
  { id: 6, name:'響け!ユーフォニアム',  keyword:'ユーフォニアム',      channels:['mx'],    enabled:true,  matches:9,    nextMatch:{ch:'mx',    title:'アニメ「響け!ユーフォニアム」', at: at('18:00')}, priority:'medium', quality:'1080i', skipReruns:true },
  { id: 7, name:'MLB 大谷出場',        keyword:'大谷',                channels:['bs1'],   enabled:true,  matches:34,   nextMatch:{ch:'bs1',   title:'MLB 大谷翔平出場試合中継',    at: at('07:00')}, priority:'high',   quality:'1080i', skipReruns:false },
  { id: 8, name:'ドキュメント72時間',   keyword:'ドキュメント72時間',  channels:['nhk-g'], enabled:false, matches:608,  nextMatch:{ch:'nhk-g', title:'ドキュメント72時間',         at: at('23:10')}, priority:'medium', quality:'1080i', skipReruns:true },
];

export const RULES: Rule[] = base.map((r) => {
  // Phase 7 exclusion fields default to empty arrays for fixture rules —
  // nothing in the seed data exercises NG keyword / genre / time-range
  // denies, and the schema treats the missing case as "no exclusion".
  const empties: Pick<Rule, 'ngKeywords' | 'genreDeny' | 'timeRangeDeny'> = {
    ngKeywords: [],
    genreDeny: [],
    timeRangeDeny: [],
  };
  const hit = Object.values(TVDB_CATALOG).find(
    (t) => t.type !== 'movie' && (r.keyword.includes(t.title) || r.name.includes(t.title))
  );
  if (hit) return { ...r, kind: 'series', tvdb: hit, ...empties };
  return { ...r, kind: 'keyword', ...empties };
});
