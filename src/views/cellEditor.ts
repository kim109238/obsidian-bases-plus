import { parsePropertyId, setIcon } from 'obsidian';
import type { App, BasesEntry, BasesPropertyId, TFile } from 'obsidian';

/**
 * 셀에서 바로 프론트매터 값을 고친다(마스터 명시 요구, 실기동 3차).
 *
 * 쓰기는 전부 공개 API 다 — `FileManager.processFrontMatter`. 네이티브 표도 같은 API 로 쓴다
 * (1.13.4 app.js `updateProperty` 실측). 원자적이고 YAML 형식을 코어가 유지해 준다(개발 원칙 관7).
 *
 * **비공개 접근 1지점**: 값이 비어 있는 셀은 값 객체가 없어 타입을 알 수 없다. 그때만
 * `app.metadataTypeManager` 로 그 속성에 등록된 타입을 읽는다 — 없으면 텍스트로 떨어진다.
 * 이 파일이 그 접근을 격리한다.
 */
export type EditableKind = 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'list';

/** 프론트매터 속성만 고칠 수 있다. file.*·formula.* 는 파일 자체나 계산식이라 네이티브도 읽기 전용이다. */
export function isEditableProperty(property: BasesPropertyId | null): property is BasesPropertyId {
	return !!property && parsePropertyId(property).type === 'note';
}

/**
 * 한 줄 입력으로 다룰 수 없는 값. 객체·계산 오류뿐이고 나머지는 전부 편집한다 —
 * 네이티브는 `note.*` 면 무엇이든 위젯 편집기를 띄우므로 여기 목록이 짧을수록 패리티가 높다.
 */
const UNEDITABLE_VALUE_TYPES = ['object', 'error'];

export function isEditableValueType(valueType: string | null): boolean {
	return valueType === null || UNEDITABLE_VALUE_TYPES.indexOf(valueType) === -1;
}

/**
 * 값이 비어 있는 셀의 값 타입. 빈 값은 `NullValue` 로 오고 그 static `type` 이 문자열 `"Null"` 이라
 * (1.13.4 app.js 오프셋 2158669) 우리 `valueTypeName()` 을 거치면 **JS null 이 아니라 문자열 `'null'`** 이다.
 * 이 둘을 같이 보지 않으면 빈 칸이 전부 텍스트 입력으로 떨어진다(마스터 6차 4번 — 빈 날짜 칸).
 */
const EMPTY_VALUE_TYPE = 'null';

function isEmptyValueType(valueType: string | null): boolean {
	return valueType === null || valueType === EMPTY_VALUE_TYPE;
}

/**
 * 이 칸이 **글자를 치는 칸**인지 — 텍스트·숫자·목록. 커서 모양을 가르는 데 쓴다(요구: "텍스트·숫자·목록의
 * 입력 위치에서만 텍스트 커서, 나머지 편집 가능 셀은 기본 커서").
 *
 * **긍정형으로 판정한다.** 10차에는 체크박스만 빼는 부정형이었는데, 요구의 "체크박스 **등** 나머지" 에는
 * 날짜·시각도 들어간다 — 그 둘이 텍스트 커서로 남아 정리가 안 된 것처럼 보였다(프리뷰 실측: 날짜 칸 `text`).
 * 빼는 목록은 앞으로도 늘 수 있으니 "치는 칸"을 세는 쪽이 안전하다.
 *
 * `resolveEditableKind` 와 달리 값 문자열이 필요 없어 셀마다 `toString()` 을 부르지 않는다.
 */
export function isTypingProperty(
	app: App,
	property: BasesPropertyId | null,
	valueType: string | null
): boolean {
	if (!isEditableProperty(property)) return false;

	switch (valueType) {
		case 'number':
		case 'list':
		case 'string':
			return true;
		// 눌러서 뒤집거나(체크박스) 달력으로 고르는(날짜·시각) 칸은 치는 칸이 아니다.
		case 'boolean':
		case 'date':
			return false;
	}

	// 링크·URL 등 나머지 값은 저장 원문을 텍스트로 고친다.
	if (!isEmptyValueType(valueType)) return true;

	// 값이 비면 등록된 유형을 본다. 모르는 유형은 텍스트 입력으로 떨어지므로 치는 칸이다.
	const kind = registeredKind(app, parsePropertyId(property).name);

	return kind === null || kind === 'text' || kind === 'number' || kind === 'list';
}

/**
 * 이 칸을 **알약으로 그릴지** 정한다(7차 1번). 값이 목록이면 당연히 알약이고, 값이 비어 있으면 등록된
 * 속성 유형이 목록 계열(multitext·tags·aliases)일 때 알약이다 — 빈 태그 칸에도 바로 추가할 수 있어야 한다.
 * 값에서 문자열을 뽑지 않아 셀마다 `toString()` 을 부르지 않는다.
 */
export function isChipProperty(
	app: App,
	property: BasesPropertyId | null,
	valueType: string | null
): property is BasesPropertyId {
	if (!isEditableProperty(property)) return false;
	if (valueType === 'list') return true;
	if (!isEmptyValueType(valueType)) return false;

	return registeredKind(app, parsePropertyId(property).name) === 'list';
}

/**
 * 이 열이 **목록 타입으로 등록돼 있는지**(`multitext`·`tags`·`aliases`). 값이 비어 있어도 판정이 서므로
 * 목록값 순서 메뉴가 나올 열을 이것으로 가른다(디자인 F2). 값에서 아무것도 읽지 않는다.
 */
export function isListProperty(app: App, property: BasesPropertyId | null): property is BasesPropertyId {
	if (!isEditableProperty(property)) return false;

	return registeredKind(app, parsePropertyId(property).name) === 'list';
}

/**
 * 셀에 심는 **등록된 속성 타입**. 정렬을 그린 값이 아니라 이 값으로 잡아야 빈 숫자 칸도 우측에 선다
 * (디자인 E5 — 네이티브 `data-property-type` 과 같은 자리·같은 이름).
 * `note.*` 가 아니면 등록된 위젯이 없으므로 null 이고, 그때는 값 타입이 정렬을 잡는다.
 */
export function registeredPropertyType(app: App, property: BasesPropertyId | null): string | null {
	if (!isEditableProperty(property)) return null;

	return registeredWidget(app, parsePropertyId(property).name);
}

/**
 * 무슨 입력으로 고칠지 정한다. 값이 있으면 그 값의 타입(공개 `Value.type`)이 우선이고,
 * **값이 비어 있으면** 등록된 속성 타입을 본다 — 빈 날짜 칸에 달력이 뜨는 경로가 이것이다.
 * 빈 칸이 편집이 안 되던 것은 앞서, 빈 칸의 타입을 못 찾던 것은 여기서 고쳤다.
 */
export function resolveEditableKind(
	app: App,
	property: BasesPropertyId,
	valueType: string | null,
	current: string
): EditableKind {
	switch (valueType) {
		case 'number':
			return 'number';
		case 'boolean':
			return 'checkbox';
		case 'date':
			// 날짜와 날짜+시각은 값 타입이 같다. 저장 문자열이 시각을 담고 있으면 시각까지 고칠 수 있어야 한다
			// (네이티브도 `mod-date` / `mod-datetime` 두 입력으로 갈린다).
			return /^\d{4}-\d{2}-\d{2}[T ]/.test(current) ? 'datetime' : 'date';
		case 'list':
			return 'list';
	}

	// 문자열·링크·URL 등은 저장된 원문(`[[노트]]` 형태 포함)을 그대로 고친다.
	if (!isEmptyValueType(valueType) && valueType !== 'string') return 'text';

	return registeredKind(app, parsePropertyId(property).name) ?? 'text';
}

/**
 * 편집기에 채울 현재 값. **화면 글자가 아니라 값 객체에서 읽는다** — 날짜·체크박스는 입력 요소로 그려져
 * 화면 텍스트가 비어 있고("날짜 칸을 누르면 값이 지워지던" 원인), 링크는 화면에 보이는 글자와
 * 저장된 원문(`[[노트|별칭]]`)이 다르다.
 */
export function readEditableValue(entry: BasesEntry, property: BasesPropertyId): string {
	try {
		const value = entry.getValue(property);
		if (!value) return '';

		// 빈 값은 NullValue 로 오고 toString() 이 문자열 "null" 이다 — 그대로 쓰면 그 글자가 입력칸에 박힌다.
		const text = value.toString();
		return text === 'null' ? '' : text;
	} catch (error) {
		console.error('Bases Plus: could not read the current property value.', error);
		return '';
	}
}

export interface CellEditRequest {
	app: App;
	file: TFile;
	property: BasesPropertyId;
	kind: EditableKind;
	/** 편집기가 들어갈 자리. 원래 값 마크업은 호출부가 비운다. */
	el: HTMLElement;
	/** 현재 화면에 보이던 문자열 — 입력 초기값으로 쓴다. */
	current: string;
	/** 목록 편집기가 항목을 하나씩 읽는 통로 — 쉼표로 나누는 것보다 정확하다. */
	entry: BasesEntry;
	/** 편집이 끝났을 때(저장·취소 모두). 호출부가 셀을 다시 그린다. */
	onDone: () => void;
}

/**
 * 조합(IME) 중의 Enter·Escape 는 우리 것이 아니다 — 한글·일본어는 그 키로 글자를 **확정**한다.
 * 가로채면 확정 전 글자가 입력칸에 반영되기 전에 저장이 돌아 방금 친 글자가 사라진다
 * (마스터 6차 3번 "엔터를 쳐도 값이 반영되지 않는다"). 네이티브도 속성 편집기마다 같은 가드를 둔다
 * (1.13.4 app.js — 숫자 편집기 오프셋 1864000 부근, 다중값 편집기 오프셋 1822474: `if (!e.isComposing)`).
 */
function isComposing(evt: KeyboardEvent): boolean {
	return evt.isComposing === true;
}

/**
 * 셀 자리에 편집기를 띄운다. Enter·포커스 이탈이면 저장, Escape 면 취소 — 네이티브 속성 편집기와 같은 규칙이다.
 *
 * **목록은 여기 오지 않는다** — 7차부터 목록·태그 칸은 표시 상태부터 알약이라 편집 모드 자체가 없다
 * (`renderChipCell`). 체크박스도 편집기를 띄우지 않고 호출부가 바로 뒤집는다.
 */
export function beginCellEdit(request: CellEditRequest): void {
	const { el, kind, current } = request;
	// 텍스트만 여러 줄이다 — 나머지 종류(숫자·날짜)는 줄바꿈이 값으로 성립하지 않는다.
	const multiline = kind === 'text';
	const inputEl = multiline
		? el.createEl('textarea', { cls: 'bases-plus-cell-input bases-plus-cell-textarea', attr: { rows: '1' } })
		: el.createEl('input', { cls: 'bases-plus-cell-input', attr: { type: inputType(kind) } });

	inputEl.value = current;
	inputEl.focus();
	inputEl.select();
	if (multiline) fitToContent(inputEl);
	// 날짜는 한 번 눌러 달력이 뜨는 것이 네이티브 감각에 가깝다 — 클릭 핸들러 안이라 사용자 제스처가 살아 있다.
	if (kind === 'date' || kind === 'datetime') showPicker(inputEl as HTMLInputElement);

	let settled = false;
	const finish = (commit: boolean): void => {
		if (settled) return;
		settled = true;

		if (commit) void writeProperty(request, parseInput(kind, inputEl.value));
		request.onDone();
	};

	// input·textarea 합집합에서는 이벤트 맵 추론이 무너진다 — 리스너 등록만 HTMLElement 로 좁혀 쓴다.
	const eventEl: HTMLElement = inputEl;

	eventEl.addEventListener('keydown', (evt) => {
		if (isComposing(evt)) return;

		if (evt.key === 'Enter') {
			// Shift+Enter 는 줄바꿈이다 — 코어 속성 편집기와 같은 규칙(app.js 오프셋 1851500: `if (e.shiftKey) return`).
			// 그냥 Enter 는 저장이라, 표시 상태의 한 줄 말줄임(가이드 절 A)과도 어긋나지 않는다.
			if (multiline && evt.shiftKey) return;

			evt.preventDefault();
			finish(true);
		} else if (evt.key === 'Escape') {
			evt.preventDefault();
			finish(false);
		}
	});
	// 줄이 늘면 편집기도 같이 자란다 — 셀은 편집 중에만 높이를 푼다(styles.css `.is-editing`).
	if (multiline) eventEl.addEventListener('input', () => fitToContent(inputEl));
	eventEl.addEventListener('blur', () => finish(true));
	// 편집 중 클릭이 행 열기·다른 셀 편집으로 새지 않게 한다.
	eventEl.addEventListener('click', (evt) => evt.stopPropagation());
}

/**
 * 여러 줄 편집기의 높이를 내용에 맞춘다. `scrollHeight` 를 읽으려면 먼저 높이를 비워야 한다 —
 * 안 그러면 줄을 지워도 한 번 늘어난 높이가 그대로 남는다. 레이아웃이 없는 하네스에서는 둘 다 없어 건너뛴다.
 */
function fitToContent(inputEl: HTMLElement): void {
	const measurable = inputEl as unknown as { scrollHeight?: unknown };
	if (typeof measurable.scrollHeight !== 'number') return;

	inputEl.setCssStyles({ height: 'auto' });
	inputEl.setCssStyles({ height: `${measurable.scrollHeight}px` });
}

/**
 * 값이 비어 있는 날짜 칸의 **표시 상태**. 네이티브는 값이 없어도 날짜 입력을 그려서 흐린
 * "연도. 월. 일." 플레이스홀더와 달력 아이콘이 보이는데, 우리는 값(`Value`)에서만 그리다 보니
 * 빈 칸이 통째로 비어 있었다 — 그게 마스터가 6차부터 말한 "뜨지 않음" 이다(8차 2번, 캡처 203219/203254).
 *
 * 네이티브 마크업을 그대로 낸다(`metadata-input metadata-input-text mod-date is-empty`) —
 * 클래스만 같으면 테마·코어 CSS 가 알아서 같은 모습을 준다. `disabled` 라 표시 전용이고,
 * 클릭은 셀이 받아 기존 편집 경로(달력)로 간다.
 *
 * @returns 그렸으면 true.
 */
export function renderEmptyDatePlaceholder(
	app: App,
	property: BasesPropertyId,
	valueType: string | null,
	el: HTMLElement
): boolean {
	if (!isEditableProperty(property) || !isEmptyValueType(valueType)) return false;

	const kind = registeredKind(app, parsePropertyId(property).name);
	if (kind !== 'date' && kind !== 'datetime') return false;

	/*
	 * `disabled` 로 둔다 — 표시 전용이고, 코어가 `.bases-rendered-value input[disabled=true]` 에 걸어 둔
	 * `pointer-events: none; min-height: 0` 과 날짜형의 `width: auto` 를 그대로 받는다(app.css:14391-14398).
	 *
	 * **달력 아이콘은 못 붙인다** — 크로미움은 상호작용하지 않는 날짜 입력(disabled·readonly 둘 다)에
	 * picker indicator 를 그리지 않는다. 네이티브가 그 아이콘을 갖는 것은 셀 자체가 살아 있는 편집기이기
	 * 때문이라, 아이콘까지 맞추려면 표시 상태를 live input 으로 바꿔야 한다(클릭→편집 모델 변경).
	 * 마스터가 못 보던 것은 "아무것도 안 보임" 이었으므로 흐린 플레이스홀더까지를 이번 범위로 둔다.
	 */
	el.createEl('input', {
		cls: `metadata-input metadata-input-text mod-${kind} is-empty bases-plus-empty-date`,
		attr: {
			type: kind === 'date' ? 'date' : 'datetime-local',
			disabled: true,
			'aria-hidden': 'true',
		},
	});

	return true;
}

export interface ChipCellRequest {
	app: App;
	file: TFile;
	property: BasesPropertyId;
	entry: BasesEntry;
	/** 알약이 들어갈 자리. 호출부가 비운 뒤 넘긴다. */
	el: HTMLElement;
	/** 현재 화면 문자열 — 항목을 못 세는 값일 때 쉼표로 나누는 대비 경로에 쓴다. */
	current: string;
	/** 입력칸에 포커스가 들고 남을 때. 호출부가 그동안 이 셀을 다시 그리지 않게 표시한다. */
	onFocusChange: (focused: boolean) => void;
}

/**
 * 목록·태그 셀을 **표시 상태에서도** 알약으로 그린다(마스터 7차 1번 — "셀에서 텍스트와 구분되지 않음.
 * tags 와 같은 형태로 보여지고, 바로 x 로 제거 가능하고, 별도 UI 변경 없이 바로 추가되도록").
 *
 * 6차의 알약 편집기와 다른 점은 **편집 모드가 없다는 것**이다. 알약과 입력칸이 늘 떠 있고, x 를 누르면
 * 그 자리에서 지워져 바로 저장되며, 뒤쪽 입력칸에 치고 Enter 를 누르면 바로 항목이 는다.
 * 준거는 네이티브 문서 속성 편집기의 상시 알약 UI 다(`.multi-select-container`, app.js 오프셋 1822474).
 *
 * @returns 다시 그릴 때 호출부가 붙잡아 둘 입력 요소.
 */
export function renderChipCell(request: ChipCellRequest): HTMLElement {
	const items = readListItems(request.entry, request.property, request.current);
	const containerEl = request.el.createDiv({ cls: 'multi-select-container bases-plus-chips' });
	const inputEl = containerEl.createEl('input', {
		cls: 'bases-plus-cell-multi-input bases-plus-chip-input',
		attr: { type: 'text' },
	});

	const save = (): Promise<void> =>
		writeValue(request.app, request.file, request.property, items.length > 0 ? items.slice() : null);

	let redrawing = false;
	const redraw = (): void => {
		redrawing = true;
		containerEl.empty();
		items.forEach((item, index) =>
			createPill(containerEl, item, () => {
				// 편집 모드 없이 그 자리에서 지우고 바로 저장한다.
				items.splice(index, 1);
				redraw();
				void save();
			})
		);
		containerEl.appendChild(inputEl);
		redrawing = false;
	};

	inputEl.addEventListener('keydown', (evt) => {
		// 조합 중 Enter 는 한글을 확정하는 키다 — 가로채면 방금 친 글자를 잃는다(6차 3번과 같은 가드).
		if (isComposing(evt)) return;

		if (evt.key === 'Enter') {
			evt.preventDefault();
			const pending = inputEl.value.trim();
			if (pending === '') return;

			items.push(pending);
			inputEl.value = '';
			redraw();
			inputEl.focus();
			void save();
		} else if (evt.key === 'Escape') {
			evt.preventDefault();
			inputEl.value = '';
			inputEl.blur();
		} else if (evt.key === 'Backspace' && inputEl.value === '' && items.length > 0) {
			evt.preventDefault();
			items.pop();
			redraw();
			inputEl.focus();
			void save();
		}
	});

	// 치다 만 글자도 버리지 않는다 — 셀을 떠나는 순간 항목으로 굳힌다.
	inputEl.addEventListener('blur', () => {
		const pending = inputEl.value.trim();
		if (pending !== '') {
			items.push(pending);
			inputEl.value = '';
			redraw();
			void save();
		}

		if (!redrawing) request.onFocusChange(false);
	});
	inputEl.addEventListener('focus', () => request.onFocusChange(true));
	// 셀 클릭이 행 열기로 새지 않게 하고, 빈자리를 눌러도 바로 칠 수 있게 한다.
	containerEl.addEventListener('click', (evt) => {
		evt.stopPropagation();
		inputEl.focus();
	});
	containerEl.addEventListener('mousedown', (evt) => {
		if (evt.target === inputEl) return;

		evt.preventDefault();
		inputEl.focus();
	});

	redraw();

	return inputEl;
}

function createPill(containerEl: HTMLElement, item: string, onRemove: () => void): void {
	const pillEl = containerEl.createDiv({ cls: 'multi-select-pill' });
	pillEl.createDiv({ cls: 'multi-select-pill-content', text: item });

	const removeEl = pillEl.createDiv({ cls: 'multi-select-pill-remove-button' });
	setIcon(removeEl, 'lucide-x');
	removeEl.addEventListener('click', (evt) => {
		evt.preventDefault();
		evt.stopPropagation();
		onRemove();
	});
}

/**
 * 목록 항목을 하나씩 읽는다. `toString()` 은 항목을 ", " 로 이어 붙이므로 항목 안에 쉼표가 있으면 되돌릴 수
 * 없다 — 그래서 항목을 직접 센다. 목록이 아니거나 못 읽으면 지금 문자열을 쉼표로 나눠 떨어진다.
 *
 * **비공개 접근이 아니다.** `ListValue.length()`·`get()` 은 둘 다 d.ts 의 `@public`(1.10.0)이고,
 * 캐스팅이 필요한 이유는 `getValue()` 의 반환 타입이 기반 `Value` 라 TS 가 목록인지 모르기 때문뿐이다
 * — `renderValue.ts` 의 `Value.type` 읽기와 같은 계열(타입 좁히기)이다. 능력 확인으로 감싼다.
 */
export function readListItems(entry: BasesEntry, property: BasesPropertyId, current: string): string[] {
	try {
		const value = entry.getValue(property) as unknown as {
			length?: () => number;
			get?: (index: number) => { toString(): string };
		} | null;

		if (!value || typeof value.length !== 'function' || typeof value.get !== 'function') {
			return splitList(current);
		}

		const items: string[] = [];
		const size = value.length();
		for (let i = 0; i < size; i++) items.push(String(value.get(i)));

		return items.map((item) => item.trim()).filter((item) => item !== '' && item !== 'null');
	} catch (error) {
		console.error('Bases Plus: could not read the list items.', error);
		return splitList(current);
	}
}

function splitList(raw: string): string[] {
	return raw
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '');
}

/** 체크박스 값은 입력칸 없이 그 자리에서 뒤집는다 — 네이티브도 체크박스는 바로 눌러 바꾼다. */
export function toggleCheckbox(
	app: App,
	file: TFile,
	property: BasesPropertyId,
	current: boolean
): Promise<void> {
	return writeValue(app, file, property, !current);
}

function inputType(kind: EditableKind): string {
	if (kind === 'number') return 'number';
	if (kind === 'date') return 'date';
	if (kind === 'datetime') return 'datetime-local';

	return 'text';
}

/** 브라우저마다 없을 수 있고, 사용자 제스처 밖이면 던진다 — 실패해도 입력칸은 그대로 쓸 수 있다. */
function showPicker(inputEl: HTMLInputElement): void {
	const picker = inputEl as unknown as { showPicker?: () => void };
	if (typeof picker.showPicker !== 'function') return;

	try {
		picker.showPicker();
	} catch {
		// 달력이 안 뜰 뿐 타이핑으로 고칠 수 있다.
	}
}

function parseInput(kind: EditableKind, raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === '') return null;

	if (kind === 'number') {
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}

	// 목록(multitext·tags·aliases)은 여기 오지 않는다 — 알약 셀이 항목 배열을 직접 저장한다(renderChipCell).
	return trimmed;
}

function writeProperty(request: CellEditRequest, value: unknown): Promise<void> {
	return writeValue(request.app, request.file, request.property, value);
}

/**
 * null 이면 속성을 지운다 — 빈 값을 빈 문자열로 남기면 프론트매터에 껍데기가 쌓인다.
 *
 * 타임라인의 끝단 드래그도 이 경로로 쓴다 — 셀 편집과 **같은 API·같은 타이밍**(놓을 때 한 번)이라
 * 쓰기가 두 갈래로 갈리지 않는다(타임라인 C3).
 */
export async function writeValue(
	app: App,
	file: TFile,
	property: BasesPropertyId,
	value: unknown
): Promise<void> {
	const name = parsePropertyId(property).name;

	try {
		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			// 대소문자만 다른 키가 이미 있으면 그 키를 그대로 쓴다 — 네이티브도 같은 자리를 찾아 쓴다.
			const key = findExistingKey(frontmatter, name) ?? name;

			if (value === null) delete frontmatter[key];
			else frontmatter[key] = value;
		});
	} catch (error) {
		console.error('Bases Plus: writing the property failed.', error);
	}
}

function findExistingKey(frontmatter: Record<string, unknown>, name: string): string | null {
	const lowered = name.toLowerCase();

	for (const key of Object.keys(frontmatter)) {
		if (key.toLowerCase() === lowered) return key;
	}

	return null;
}

/**
 * 위젯 → 아이콘. 네이티브 헤더는 `metadataTypeManager.getWidget(위젯).icon` 으로 코어 등록표에서 바로 꺼내지만,
 * 그러면 비공개 표면이 한 겹 더 늘어난다 — 그래서 그 등록표를 실측해 여기 옮겼다
 * (1.13.4 app.js 오프셋 1732300 `registeredTypeWidgets` 와 각 위젯 정의 1849700~1869500).
 *
 * 값은 코어와 1:1 이다. 옵시디언이 아이콘을 바꿔도 깨지지 않고 **틀린 아이콘만** 남는 종류의 부채라,
 * 갱신할 자리를 이 표 하나로 모아 둔다.
 */
const WIDGET_ICONS: Record<string, string> = {
	aliases: 'lucide-forward',
	checkbox: 'lucide-check-square',
	date: 'lucide-calendar',
	datetime: 'lucide-clock',
	file: 'lucide-file',
	folder: 'lucide-folder',
	multitext: 'lucide-list',
	number: 'lucide-binary',
	property: 'lucide-info',
	tags: 'lucide-tags',
	text: 'lucide-text',
};

/** 등록표에 없는 위젯. 코어도 같은 자리에서 이 아이콘으로 떨어진다(app.js 오프셋 1869700 — `unknown` 위젯). */
const UNKNOWN_WIDGET_ICON = 'lucide-file-question';

/**
 * 열 헤더에 붙는 속성 유형 아이콘. 네이티브 표 헤더의 `render()` 와 같은 갈래다(app.js 오프셋 3143700):
 * `note.*` 는 등록된 위젯의 아이콘, `formula.*`·`file.*` 는 출처가 정해 주는 고정 아이콘이다.
 */
export function propertyTypeIcon(app: App, property: BasesPropertyId): string {
	const { type, name } = parsePropertyId(property);

	if (type === 'formula') return 'lucide-square-function';
	if (type === 'file') return 'lucide-info';

	const widget = registeredWidget(app, name);

	return widget === null ? UNKNOWN_WIDGET_ICON : WIDGET_ICONS[widget] ?? UNKNOWN_WIDGET_ICON;
}

/** 등록된 위젯 이름을 편집기 종류로 옮긴다. 모르는 위젯이면 null 이라 텍스트 입력으로 떨어진다. */
function registeredKind(app: App, name: string): EditableKind | null {
	switch (registeredWidget(app, name)) {
		case 'number':
			return 'number';
		case 'checkbox':
			return 'checkbox';
		case 'date':
			return 'date';
		case 'datetime':
			return 'datetime';
		case 'multitext':
		case 'tags':
		case 'aliases':
			return 'list';
		case 'text':
			return 'text';
		default:
			return null;
	}
}

/**
 * **이 플러그인에서 `app.metadataTypeManager` 를 만지는 유일한 자리다**(비공개 1지점 — d.ts 에 없다).
 * 값이 비어 타입을 알 수 없는 셀의 편집기 종류와 열 헤더의 유형 아이콘이 둘 다 이 한 통로를 쓴다.
 * 기능 감지로 감싸 접근이 실패해도 편집·렌더가 멈추지 않게 했다 — 실패하면 텍스트·미지 아이콘으로 떨어진다.
 *
 * 코어도 이름을 소문자로 낮춰 찾고, 못 찾으면 `{ widget: "text" }` 를 돌려준다(app.js `getPropertyInfo`).
 */
function registeredWidget(app: App, name: string): string | null {
	try {
		const manager = (app as unknown as {
			metadataTypeManager?: { getPropertyInfo?(key: string): { widget?: unknown } };
		}).metadataTypeManager;

		if (!manager || typeof manager.getPropertyInfo !== 'function') return null;

		const widget = manager.getPropertyInfo(name.toLowerCase())?.widget;

		return typeof widget === 'string' ? widget : null;
	} catch (error) {
		console.error('Bases Plus: could not read the registered property type.', error);
		return null;
	}
}
