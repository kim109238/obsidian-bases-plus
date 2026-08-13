import { setIcon } from 'obsidian';
import type { PagerState } from './rowPlan';
import { t } from '../shared/i18n';

/**
 * `‹ 2 / 7 ›` 한 벌. **뷰 푸터(F3)와 그룹 푸터(F10)가 같은 것을 쓴다** — 다른 것은 감싸는 줄이
 * 고정(sticky)이냐 흐름 안이냐뿐이다(디자인 D4).
 *
 * 페이지 표시를 누르면 그 자리가 입력칸이 된다. 계약은 셀 편집과 같다 — Enter 저장 · Escape 취소 ·
 * 포커스 이탈은 Enter 와 같다(B3).
 */
export interface PagerHandle {
	el: HTMLElement;
	/** null 이면 감춘다 — 페이지가 하나뿐인 그룹에는 페이저를 만들지 않는다. */
	update(state: PagerState | null): void;
}

export interface PagerOptions {
	/**
	 * 리스너를 뷰 수명에 묶는 통로. `Component.registerDomEvent` 를 그대로 받는다(관2).
	 * 이벤트 종류가 둘뿐이라 `any` 대신 합집합으로 좁혀 둔다.
	 */
	register(el: HTMLElement, type: 'click' | 'keydown', handler: (evt: Event) => void): void;
	onGo(page: number): void;
}

/**
 * @param cls 감싸는 줄의 클래스. 뷰 푸터는 `bases-plus-footer-bar`, 그룹 푸터는 `bases-plus-group-pager` 다 —
 *   둘이 서는 자리의 왼쪽 여백 주인이 달라서(A3) 축을 잡는 규칙만 갈린다.
 */
export function createPager(parentEl: HTMLElement, options: PagerOptions, cls: string): PagerHandle {
	const el = parentEl.createDiv({ cls });
	let state: PagerState = { page: 1, pageCount: 1 };
	let editing = false;

	// 화살표는 코어가 "한 칸 이동"에 쓰는 그 글리프다(lucide-chevron-*).
	const prevEl = createButton(el, 'lucide-chevron-left', t('Previous page'));
	const pageEl = el.createDiv({ cls: 'bases-plus-pager-page' });
	const nextEl = createButton(el, 'lucide-chevron-right', t('Next page'));

	pageEl.setAttr('role', 'button');
	pageEl.setAttr('tabindex', '0');

	const go = (page: number): void => {
		// 범위 밖 숫자는 가장 가까운 페이지로 당긴다 — 빈 화면을 만들지 않는다(B3).
		const next = Math.min(Math.max(1, Math.floor(page) || 1), state.pageCount);
		if (next !== state.page) options.onGo(next);
	};

	options.register(prevEl, 'click', () => go(state.page - 1));
	options.register(nextEl, 'click', () => go(state.page + 1));
	options.register(pageEl, 'click', () => beginEdit());
	options.register(pageEl, 'keydown', (evt) => {
		const key = (evt as KeyboardEvent).key;
		if (key !== 'Enter' && key !== ' ') return;

		evt.preventDefault();
		beginEdit();
	});

	function beginEdit(): void {
		if (editing) return;

		editing = true;
		pageEl.empty();

		const inputEl = pageEl.createEl('input', {
			cls: 'bases-plus-pager-input',
			attr: { type: 'text', inputmode: 'numeric', 'aria-label': t('Page number') },
		});
		inputEl.value = String(state.page);
		inputEl.focus();
		inputEl.select();

		let settled = false;
		const finish = (commit: boolean): void => {
			if (settled) return;

			settled = true;
			editing = false;
			const typed = Number(inputEl.value.trim());
			render();
			if (commit && Number.isFinite(typed)) go(typed);
		};

		inputEl.addEventListener('keydown', (evt) => {
			// 조합 중 Enter 는 글자를 확정하는 키다 — 셀 편집기와 같은 가드를 둔다.
			if (evt.isComposing === true) return;

			if (evt.key === 'Enter') {
				evt.preventDefault();
				finish(true);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				finish(false);
			}
		});
		// 포커스 이탈은 Enter 와 같다 — 셀 편집과 같은 규칙(B3).
		inputEl.addEventListener('blur', () => finish(true));
		inputEl.addEventListener('click', (evt) => evt.stopPropagation());
	}

	function render(): void {
		pageEl.setText(`${state.page} / ${state.pageCount}`);
		pageEl.setAttr('aria-label', t('Page {{page}} of {{count}}', { page: state.page, count: state.pageCount }));
		setDisabled(prevEl, state.page <= 1);
		setDisabled(nextEl, state.page >= state.pageCount);
	}

	render();

	return {
		el,
		update(next) {
			if (!next) {
				el.hide();
				return;
			}

			el.show();
			state = next;
			// 숫자를 치고 있는 중이면 그 칸을 덮지 않는다 — 셀 편집과 같은 규칙이다.
			if (!editing) render();
		},
	};
}

function createButton(parentEl: HTMLElement, icon: string, label: string): HTMLElement {
	const el = parentEl.createEl('button', {
		cls: 'bases-plus-pager-button',
		attr: { type: 'button', 'aria-label': label },
	});
	setIcon(el, icon);

	return el;
}

/**
 * 프로퍼티만 세운다 — 실물 `HTMLButtonElement` 은 이 값을 속성으로 되비추므로
 * CSS `:disabled` 와 키보드 건너뛰기가 함께 따라온다. 속성을 직접 넣고 빼면 두 자리가 어긋날 수 있다.
 */
function setDisabled(el: HTMLElement, disabled: boolean): void {
	(el as HTMLButtonElement).disabled = disabled;
}
