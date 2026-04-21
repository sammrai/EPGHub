import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { kanaFold } from './textFold.ts';

describe('kanaFold', () => {
  it('hiragana → katakana 1:1 shift', () => {
    assert.equal(kanaFold('どらま'), 'ドラマ');
    assert.equal(kanaFold('おかあさんといっしょ'), 'オカアサントイッショ');
    // 濁点/半濁点付き
    assert.equal(kanaFold('ぱぴぷぺぽ'), 'パピプペポ');
    // ゔ → ヴ
    assert.equal(kanaFold('ゔぁいお'), 'ヴァイオ');
  });

  it('カタカナ入力はそのまま', () => {
    assert.equal(kanaFold('ドラマ'), 'ドラマ');
  });

  it('全角英数字 → 半角', () => {
    assert.equal(kanaFold('ＮＨＫ総合'), 'NHK総合');
    assert.equal(kanaFold('ＡＢＣ１２３'), 'ABC123');
    assert.equal(kanaFold('ａｂｃ'), 'abc');
    assert.equal(kanaFold('　'), ' '); // 全角空白
  });

  it('漢字・ASCII はそのまま (仮名は一律カタカナ化)', () => {
    // 「の」はひらがななのでカタカナ化されるのが仕様。漢字/ASCII は素通り。
    assert.equal(kanaFold('大河ドラマ 風の群像'), '大河ドラマ 風ノ群像');
    assert.equal(kanaFold('NHK 123 abc'), 'NHK 123 abc');
  });

  it('空文字/記号を壊さない', () => {
    assert.equal(kanaFold(''), '');
    assert.equal(kanaFold('!?#'), '!?#');
    assert.equal(kanaFold('第16回'), '第16回');
  });
});
