import type { SetURLSearchParams } from 'react-router-dom';

// Modal は `?modal=<programId>` を URL に載せることで「どのページに居ても・
// deep link からでも・リロードしても」同じ挙動で開く。複数の起点 (Grid の
// セル押下、Discover のランキング引用 etc.) が同じ UX を提供する必要があり、
// 開く側のロジックはこの 1 箇所に集約しておく。
//
// history entry の state には 2 つの目印を持たせる:
//
// - `modalOpenedInApp` … 「自分で push したエントリ (= navigate(-N) で対称に
//   戻せる)」と「deep link からの初回エントリ (= 戻っても以前の入口には戻ら
//   ないので setSearchParams で param を剥がす)」を判別する印。
//
// - `modalDepth` … モーダルが何段スタックされているか。関連番組リンクで A → B
//   と push したとき、× で「全部閉じる」を実現するために必要。closeModal は
//   この値を読んで navigate(-modalDepth) する。一段戻るだけのブラウザ戻る
//   ボタン挙動 (= 直前のモーダルへ) と差別化される。
//
// モーダル間遷移 (関連番組クリック等) も push する — ブラウザの戻るボタン
// で直前のモーダルへ辿れるようにするため。`replace: true` はテストや特殊
// な遷移用に残しているが、通常のオープン経路では使わない。
export function pushModalToUrl(
  setSearchParams: SetURLSearchParams,
  modalId: string,
  options?: { replace?: boolean; depth?: number },
): void {
  const depth = options?.depth ?? 1;
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      next.set('modal', modalId);
      return next;
    },
    {
      state: { modalOpenedInApp: true, modalDepth: depth },
      replace: options?.replace ?? false,
    },
  );
}

export interface ModalHistoryState {
  modalOpenedInApp?: boolean;
  modalDepth?: number;
}

export function wasOpenedInApp(state: unknown): boolean {
  return !!(state as ModalHistoryState | null)?.modalOpenedInApp;
}

export function modalDepthOf(state: unknown): number {
  return (state as ModalHistoryState | null)?.modalDepth ?? 0;
}
