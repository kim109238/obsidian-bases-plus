import { Modal, setIcon } from 'obsidian';
import type { App, BasesEntry, BasesPropertyId, BasesViewConfig } from 'obsidian';
import { OrderDrag } from './orderDrag';
import type { OrderSlot } from './orderDrag';
import { t } from '../shared/i18n';
import { readListItems, readEditableValue } from './cellEditor';

/**
 * 목록 타입 열이 쓰는 **값 집합의 표준 순서**(디자인 F · 마스터 확정 2026-08-05).
 * 한 셀 안의 값 순서가 아니라 그 열이 쓰는 값들의 순서이고, 행 정렬과 그룹 헤딩 순서에 적용된다.
 *
 * **저장 키는 `listValueOrder` 로 고정한다.** 뷰 config 예약 이름(`order`·`sort`·`limit`·`data`·`groupBy` 등)과
 * 겹치면 값이 뷰 최상위 키로 나가고 전용 파서가 예외를 던져 **base 파일이 통째로 안 열린다**
 * (판정 정본 목록값 order 함정 A).
 */
export const LIST_VALUE_ORDER_KEY = 'listValueOrder';

/** 저장 형태는 `{ 속성id: 값 배열 }`. 배열이 아니면 없는 것으로 보고 사전순으로 떨어진다(F5). */
export function readValueOrder(
	config: BasesViewConfig | undefined,
	property: BasesPropertyId
): string[] {
	const stored = config?.get(LIST_VALUE_ORDER_KEY);
	if (!stored || typeof stored !== 'object') return [];

	const order = (stored as Record<string, unknown>)[property];
	if (!Array.isArray(order)) return [];

	return order.filter((item): item is string => typeof item === 'string');
}

/** 비면 그 열의 키를 지우고, 남는 열이 없으면 설정 자체를 지운다 — `.base` 에 껍데기가 쌓이지 않게. */
export function saveValueOrder(
	config: BasesViewConfig,
	property: BasesPropertyId,
	order: string[] | null
): void {
	const stored = config.get(LIST_VALUE_ORDER_KEY);
	const record: Record<string, unknown> =
		stored && typeof stored === 'object' ? { ...(stored as Record<string, unknown>) } : {};

	if (order === null || order.length === 0) delete record[property];
	else record[property] = order;

	config.set(LIST_VALUE_ORDER_KEY, Object.keys(record).length > 0 ? record : null);
}

/**
 * 후보 값 — **지금 쿼리 결과에 실제로 나타난 값**만 모은다. 볼트 전역 후보를 쓰려면 비공개가 필요한데,
 * base 에 없는 값의 순서를 정해 봐야 화면에 쓰이지 않는다(F3).
 *
 * 저장된 순서를 앞에 세우고(그 열에 아직 남아 있는 값만), 나머지는 사전순으로 뒤에 붙인다.
 */
export function collectValues(
	entries: BasesEntry[],
	property: BasesPropertyId,
	saved: string[]
): string[] {
	const seen = new Set<string>();

	for (const entry of entries) {
		for (const item of readListItems(entry, property, readEditableValue(entry, property))) {
			seen.add(item);
		}
	}

	const ordered = saved.filter((value) => seen.has(value));
	const rest = Array.from(seen).filter((value) => ordered.indexOf(value) === -1);
	rest.sort((a, b) => a.localeCompare(b));

	return ordered.concat(rest);
}

const EMPTY_TEXT = 'No values yet. Values appear here once notes in this base use this property.';

export interface ValueOrderRequest {
	app: App;
	/** 제목 자리에 온다 — 무엇의 순서를 정하는 중인지가 제목이다. */
	title: string;
	values: string[];
	/** 놓는 순간 저장한다. 저장·확인 버튼이 없다 — 이 플러그인에 확인 버튼이 있는 화면은 하나도 없다(F3). */
	onOrder(order: string[] | null): void;
}

/**
 * 순서 대화상자. 확정분 모달 껍데기(헤더 40px · 제목 왼쪽 12px · 액션과 X 가 같은 오른쪽 축)를 그대로 쓰고,
 * 손잡이·드롭 표시자·키보드 계약은 **C 절의 행 순서와 같은 것**을 쓴다.
 */
export function openValueOrderModal(request: ValueOrderRequest): Modal {
	const modal = new ValueOrderModal(request);
	modal.open();

	return modal;
}

class ValueOrderModal extends Modal {
	private values: string[];
	private listEl: HTMLElement | null = null;
	private indicatorEl: HTMLElement | null = null;
	/** 목록 요소가 생긴 뒤에 만든다 — 드래그는 그 두 요소를 좌표 기준으로 쓴다. */
	private drag: OrderDrag | null = null;

	constructor(private readonly request: ValueOrderRequest) {
		super(request.app);
		this.values = request.values.slice();
	}

	onOpen(): void {
		this.modalEl.addClass('bases-plus-modal');
		this.modalEl.addClass('bases-plus-value-order-modal');
		this.modalEl.setAttr('aria-label', this.request.title);

		const { contentEl } = this;
		contentEl.empty();

		const headerEl = contentEl.createDiv({ cls: 'bases-plus-modal-header' });
		headerEl.createDiv({ cls: 'bases-plus-modal-title', text: this.request.title });

		const actionsEl = headerEl.createDiv({ cls: 'bases-plus-modal-actions' });
		const resetEl = actionsEl.createEl('button', {
			cls: 'bases-plus-modal-action',
			attr: { type: 'button', 'aria-label': t('Reset order') },
		});
		// 코어가 결과 수 제한을 되돌리는 버튼에 쓰는 그 아이콘이다.
		setIcon(resetEl.createSpan({ cls: 'bases-plus-modal-action-icon' }), 'lucide-rotate-ccw');
		resetEl.createSpan({ text: t('Reset order') });
		resetEl.addEventListener('click', () => this.reset());

		this.listEl = contentEl.createDiv({ cls: 'bases-plus-value-order-list' });
		this.indicatorEl = this.listEl.createDiv({ cls: 'bases-plus-drop-indicator' });
		this.drag = new OrderDrag({
			containerEl: this.listEl,
			indicatorEl: this.indicatorEl,
			slots: () => this.slots(),
			commit: (ids) => this.commit(ids),
		});
		this.renderItems();
	}

	onClose(): void {
		this.drag?.cancel();
		this.contentEl.empty();
	}

	/** 저장된 순서를 지우고 사전순으로 돌아간다. */
	private reset(): void {
		this.values = this.values.slice().sort((a, b) => a.localeCompare(b));
		this.request.onOrder(null);
		this.renderItems();
	}

	private commit(ids: string[]): void {
		this.values = ids;
		this.request.onOrder(ids.slice());
		this.renderItems();
	}

	private slots(): OrderSlot[] {
		const listEl = this.listEl;
		if (!listEl) return [];

		return listEl.children
			? Array.from(listEl.children)
					.filter((el): el is HTMLElement => (el as HTMLElement).hasClass?.('bases-plus-value-order-item'))
					.map((el) => ({ el, id: el.getAttr('data-value') ?? '' }))
			: [];
	}

	private renderItems(): void {
		const listEl = this.listEl;
		const indicatorEl = this.indicatorEl;
		if (!listEl || !indicatorEl) return;

		listEl.empty();
		listEl.appendChild(indicatorEl);
		// 항목이 하나뿐이면 순서를 정할 것이 없다. 드롭 표시자가 형제로 있어 CSS 의 `:only-*` 계열로는
		// 갯수를 셀 수 없으므로 여기서 알려 준다.
		listEl.toggleClass('is-single', this.values.length === 1);

		if (this.values.length === 0) {
			listEl.createDiv({ cls: 'bases-plus-value-order-empty', text: t(EMPTY_TEXT) });
			return;
		}

		for (const value of this.values) {
			const itemEl = listEl.createDiv({ cls: 'bases-plus-value-order-item' });
			itemEl.setAttr('data-value', value);
			itemEl.createDiv({ cls: 'bases-plus-value-order-label', text: value });

			// 손잡이는 **내용 뒤에** 붙인다 — 절대 배치라 자리는 같고, 행과 순서를 맞춰 둔다(C2 함정).
			const handleEl = itemEl.createDiv({ cls: 'bases-plus-order-handle' });
			setIcon(handleEl, 'lucide-grip-vertical');
			handleEl.setAttr('role', 'button');
			handleEl.setAttr('tabindex', '0');
			handleEl.setAttr('aria-label', t('Reorder value'));

			handleEl.addEventListener('pointerdown', (evt) => this.drag?.start(value, handleEl, evt));
			handleEl.addEventListener('pointermove', (evt) => this.drag?.move(evt));
			handleEl.addEventListener('pointerup', (evt) => this.drag?.end(evt));
			handleEl.addEventListener('pointercancel', () => this.drag?.cancel());
			handleEl.addEventListener('keydown', (evt) => {
				const delta = evt.key === 'ArrowUp' ? -1 : evt.key === 'ArrowDown' ? 1 : 0;
				if (delta === 0) return;

				evt.preventDefault();
				this.drag?.nudge(value, delta);
			});
		}
	}
}
