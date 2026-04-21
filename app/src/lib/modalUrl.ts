import type { SetURLSearchParams } from 'react-router-dom';

// Modal は `?modal=<programId>` を URL に載せることで「どのページに居ても・
// deep link からでも・リロードしても」同じ挙動で開く。複数の起点 (Grid の
// セル押下、Discover のランキング引用 etc.) が同じ UX を提供する必要があり、
// 開く側のロジックはこの 1 箇所に集約しておく。
//
// `modalOpenedInApp` を history entry の state に貼っておくことで、閉じる側
// は「自分で push したエントリ (= navigate(-1) で対称に戻せる)」と「deep link
// からの初回エントリ (= 戻っても以前の入口には戻らないので setSearchParams
// で param を剥がす)」を判別できる。closeModal 側は App.tsx に集約。
export function pushModalToUrl(
  setSearchParams: SetURLSearchParams,
  modalId: string,
): void {
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev);
      next.set('modal', modalId);
      return next;
    },
    { state: { modalOpenedInApp: true } },
  );
}

export interface ModalHistoryState {
  modalOpenedInApp?: boolean;
}

export function wasOpenedInApp(state: unknown): boolean {
  return !!(state as ModalHistoryState | null)?.modalOpenedInApp;
}
