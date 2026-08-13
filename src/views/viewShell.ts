import { t } from '../shared/i18n';

/**
 * 뷰 껍데기 중 **표·달력이 똑같이 쓰는 두 줄** — 안내 띠와 오류 줄.
 *
 * 뷰마다 다시 만들면 같은 성격의 줄이 뷰마다 다른 문구·다른 여백을 갖게 된다. 요소를 만드는 자리가
 * 뷰마다 다르므로(표는 머리 위, 달력은 머리와 요일 줄 사이) 통째로 세우는 함수 하나가 아니라
 * **만들기와 갱신을 나눈 네 함수**로 둔다.
 */

/**
 * 기능이 조건 때문에 지금 동작하지 않을 때만 나오는 한 줄(표 A4). 오류가 아니라 상태 설명이다.
 */
export function createNoticeEl(parentEl: HTMLElement): HTMLElement {
	const el = parentEl.createDiv({ cls: 'bases-plus-notice' });
	el.hide();

	return el;
}

/**
 * 안내 문구는 **여기 한 곳에서** 옮긴다 — 문구를 만드는 층(`rowPlan`)이 계산 전용이라 번역을 들일 수 없다.
 * 이미 옮겨진 문구(그래프가 수를 끼워 조립한 것)는 사전에 없어 그대로 지나간다.
 */
export function syncNoticeEl(el: HTMLElement, notice: string | null): void {
	if (notice === null) {
		el.hide();
		el.setText('');
		return;
	}

	el.show();
	el.setText(t(notice));
}

export function createErrorEl(parentEl: HTMLElement): HTMLElement {
	const el = parentEl.createDiv({ cls: 'bases-plus-error' });
	el.hide();

	return el;
}

/**
 * 렌더가 실패했을 때. **루트 요소를 지우지 않는다** — 임베드 안 `.bases-view:empty` 는
 * `display: none` 이라 화면에서 흔적 없이 사라진다(임베드 함정 B).
 */
export function showViewError(el: HTMLElement): void {
	el.show();
	el.setText(t('Bases Plus could not render this view. Open the developer console for the reason.'));
}
