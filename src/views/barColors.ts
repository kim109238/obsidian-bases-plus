import { Modal, setIcon } from 'obsidian';
import type { App, BasesEntry, BasesPropertyId, BasesViewConfig } from 'obsidian';
import { readEditableValue, readListItems } from './cellEditor';
import { t } from '../shared/i18n';

/**
 * 상태·태그별 막대 색(디자인 확정 8). 색을 만들지 않는다 — **옵시디언 8색 팔레트**를
 * `--bases-plus-series-1`…`-8` 로 감싸 그래프 뷰와 같은 표를 쓴다(8-2). 한 플러그인 안에 색표가 둘이면
 * 같은 값이 뷰마다 다른 색이 된다.
 *
 * 저장 키는 `barColors` 다 — 뷰 config 예약 이름(`order`·`sort`·`limit`·`data`·`groupBy`)을 비껴간다.
 * 겹치면 `.base` 가 통째로 안 열린다(표 뷰 F5 에서 실측된 함정).
 */
export const BAR_COLORS_KEY = 'barColors';
export const COLOR_BY_KEY = 'colorBy';

/** 팔레트 자리 수. 그래프 뷰 명세와 같은 8 이고, 아홉째부터는 돌려 쓴다. */
export const PALETTE_SIZE = 8;

/** 저장 형태는 `{ 값: 팔레트번호 }`. 손으로 고친 `.base` 에서 오므로 관대하게 읽는다(표 뷰 F5 선례). */
export function readBarColors(config: BasesViewConfig | undefined): Map<string, number> {
	const stored: unknown = config?.get(BAR_COLORS_KEY);
	const out = new Map<string, number>();
	if (!stored || typeof stored !== 'object') return out;

	const record = stored as Record<string, unknown>;

	for (const value of Object.keys(record)) {
		const raw = record[value];
		const slot = typeof raw === 'number' ? raw : Number(raw);
		if (Number.isFinite(slot) && slot >= 1 && slot <= PALETTE_SIZE) out.set(value, Math.floor(slot));
	}

	return out;
}

export function saveBarColors(config: BasesViewConfig, colors: Map<string, number>): void {
	const record: Record<string, number> = {};
	colors.forEach((index, value) => {
		record[value] = index;
	});

	config.set(BAR_COLORS_KEY, Object.keys(record).length > 0 ? record : null);
}

/**
 * 값 → 팔레트 번호. **저장된 매핑이 이기고, 없는 값은 목록 자리로 자동 배정한다**(확정 ⓑ — 자동 배정을
 * 초기값으로 깔고 대화상자에서 바꾼다). 켜자마자 색이 있어야 기능이 켜진 것으로 보인다.
 */
export function resolveBarColors(values: string[], saved: Map<string, number>): Map<string, number> {
	const out = new Map<string, number>();

	values.forEach((value, index) => {
		out.set(value, saved.get(value) ?? (index % PALETTE_SIZE) + 1);
	});

	// 지금 쿼리에 없는 값도 저장돼 있으면 그대로 남긴다 — 필터를 좁혔다 넓혔을 때 색이 바뀌지 않게.
	saved.forEach((index, value) => {
		if (!out.has(value)) out.set(value, index);
	});

	return out;
}

/**
 * 그 행이 쓸 색. 값이 여럿인 경우(태그가 셋 붙은 노트)는 **목록 위에서부터 처음 일치하는 값**의 색이다 —
 * 목록 순서가 곧 우선순위라 따로 설명할 것이 없다(8-3).
 *
 * @returns 팔레트 번호. 색을 줄 값이 없으면 null 이고, 그때 막대는 강조색으로 남는다.
 */
export function barColorFor(
	entry: BasesEntry,
	property: BasesPropertyId,
	order: string[],
	colors: Map<string, number>
): number | null {
	const items = readListItems(entry, property, readEditableValue(entry, property));
	if (items.length === 0) return null;

	for (const value of order) {
		if (items.indexOf(value) !== -1) return colors.get(value) ?? null;
	}

	// 목록에 없는 값(갱신 직후 새로 생긴 값)은 저장 매핑만 본다 — 없으면 강조색이다.
	for (const item of items) {
		const found = colors.get(item);
		if (found !== undefined) return found;
	}

	return null;
}

export interface BarColorRequest {
	app: App;
	/** 무엇의 색을 정하는 중인지가 제목이다 — 값 순서 대화상자와 같은 규칙. */
	title: string;
	values: string[];
	colors: Map<string, number>;
	/** 스와치를 누르는 순간 저장한다. 확인 버튼이 있는 화면은 이 플러그인에 하나도 없다(F3). */
	onChange(colors: Map<string, number>): void;
}

const EMPTY_TEXT = 'No values yet. Values appear here once notes in this base use this property.';

/**
 * 색 대화상자. **표 뷰의 값 순서 대화상자와 같은 어휘**를 쓴다(`.bases-plus-modal-header` + 값 목록) —
 * 값마다 오른쪽에 8색 스와치를 놓고 고른 것에 테두리를 준다. 새 컴포넌트를 만들지 않는다(8-3).
 */
export function openBarColorModal(request: BarColorRequest): Modal {
	const modal = new BarColorModal(request);
	modal.open();

	return modal;
}

class BarColorModal extends Modal {
	private readonly colors: Map<string, number>;
	private listEl: HTMLElement | null = null;

	constructor(private readonly request: BarColorRequest) {
		super(request.app);
		this.colors = new Map(request.colors);
	}

	onOpen(): void {
		this.modalEl.addClass('bases-plus-modal');
		this.modalEl.addClass('bases-plus-bar-color-modal');
		this.modalEl.setAttr('aria-label', this.request.title);

		const { contentEl } = this;
		contentEl.empty();

		const headerEl = contentEl.createDiv({ cls: 'bases-plus-modal-header' });
		headerEl.createDiv({ cls: 'bases-plus-modal-title', text: this.request.title });

		const actionsEl = headerEl.createDiv({ cls: 'bases-plus-modal-actions' });
		const resetEl = actionsEl.createEl('button', {
			cls: 'bases-plus-modal-action',
			attr: { type: 'button', 'aria-label': t('Reset colors') },
		});
		setIcon(resetEl.createSpan({ cls: 'bases-plus-modal-action-icon' }), 'lucide-rotate-ccw');
		resetEl.createSpan({ text: t('Reset colors') });
		resetEl.addEventListener('click', () => this.reset());

		this.listEl = contentEl.createDiv({ cls: 'bases-plus-bar-color-list' });
		this.renderItems();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** 저장된 매핑을 지우고 자동 배정으로 돌아간다. */
	private reset(): void {
		this.colors.clear();
		this.request.onChange(new Map());
		this.renderItems();
	}

	private choose(value: string, slot: number): void {
		this.colors.set(value, slot);
		this.request.onChange(new Map(this.colors));
		this.renderItems();
	}

	private renderItems(): void {
		const listEl = this.listEl;
		if (!listEl) return;

		listEl.empty();

		if (this.request.values.length === 0) {
			listEl.createDiv({ cls: 'bases-plus-bar-color-empty', text: t(EMPTY_TEXT) });
			return;
		}

		this.request.values.forEach((value, index) => {
			const itemEl = listEl.createDiv({ cls: 'bases-plus-bar-color-item' });
			itemEl.setAttr('data-value', value);
			itemEl.createDiv({ cls: 'bases-plus-bar-color-label', text: value });

			const swatchesEl = itemEl.createDiv({ cls: 'bases-plus-bar-color-swatches' });
			const current = this.colors.get(value) ?? (index % PALETTE_SIZE) + 1;

			for (let slot = 1; slot <= PALETTE_SIZE; slot++) {
				const swatchEl = swatchesEl.createEl('button', {
					cls: 'bases-plus-bar-color-swatch',
					attr: { type: 'button', 'aria-label': t('Color {{index}}', { index: slot }), 'data-slot': String(slot) },
				});
				swatchEl.setCssStyles({ backgroundColor: `var(--bases-plus-series-${slot})` });
				swatchEl.toggleClass('is-selected', slot === current);
				swatchEl.addEventListener('click', () => this.choose(value, slot));
			}
		});
	}
}
