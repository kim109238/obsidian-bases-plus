import type { BasesPropertyId, BasesViewConfig } from 'obsidian';

/**
 * 열 폭은 네이티브 표와 **같은 키·같은 형태**로 저장한다 — `.base` 의 그 뷰 항목에 `columnSize: { <속성 id>: 픽셀 }`.
 *
 * 네이티브도 공개 API 로 이 키를 쓴다 — 표 뷰의 `saveColumnSizes()` 가 `config.set("columnSize", {...})`,
 * 읽기는 `config.get("columnSize")` 다(1.13.4 app.js 실측). `BasesViewConfig.set`·`get` 은 d.ts 공개라
 * 우리도 비공개 접근 없이 같은 자리에 쓴다. 그래서 뷰 `type` 만 바꿔도 폭이 그대로 따라온다.
 */
export const COLUMN_SIZE_KEY = 'columnSize';

/** 네이티브가 `--bases-table-column-min-width` 기본값으로 쓰는 값. 이보다 좁히면 셀 내용이 보이지 않는다. */
export const MIN_COLUMN_WIDTH = 40;

/**
 * 저장된 값은 사용자가 손으로 고칠 수 있는 `.base` 에서 온다 — 숫자·하한을 통과한 것만 받는다.
 *
 * `config` 가 아직 없을 수도 있다: 컨트롤러가 뷰를 만든 **뒤에** `view.config` 를 붙이므로(app.js 오프셋 2500709)
 * 생성자 시점에는 undefined 다. d.ts 는 이 순서를 적어 두지 않아 방어한다.
 */
export function readColumnWidths(config: BasesViewConfig | undefined): Map<BasesPropertyId, number> {
	const widths = new Map<BasesPropertyId, number>();
	if (!config) return widths;

	const stored = config.get(COLUMN_SIZE_KEY);

	if (!stored || typeof stored !== 'object') return widths;

	const record = stored as Record<string, unknown>;

	for (const property of Object.keys(record)) {
		const width = record[property];
		if (typeof width === 'number' && width >= MIN_COLUMN_WIDTH) {
			widths.set(property as BasesPropertyId, Math.round(width));
		}
	}

	return widths;
}

/** 비어 있으면 키 자체를 지운다 — `set(key, null)` 이 삭제라는 것은 d.ts 시그니처(`any | null`)에 있다. */
export function saveColumnWidths(
	config: BasesViewConfig,
	widths: Map<BasesPropertyId, number>
): void {
	if (widths.size === 0) {
		config.set(COLUMN_SIZE_KEY, null);
		return;
	}

	const stored: Record<string, number> = {};
	widths.forEach((width, property) => {
		stored[property] = width;
	});

	config.set(COLUMN_SIZE_KEY, stored);
}
