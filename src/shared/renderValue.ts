import type { App, BasesEntry, BasesPropertyId, Value } from 'obsidian';

/**
 * 셀 값은 반드시 `Value.renderTo` 를 태운다 — 네이티브 표·목록의 셀 렌더러가 부르는 것과 같은 API 라
 * 마크업이 구조적으로 동일해진다. `toString()` 으로 문자열을 뽑아 직접 그리면 링크·체크박스·날짜 입력이 전부 평문이 된다.
 *
 * @returns 그린 값의 타입 이름(소문자 — `number`·`boolean`·`file` 등). 값이 없어 아무것도 안 그렸으면 null.
 */
export function renderValue(
	app: App,
	entry: BasesEntry,
	propertyId: BasesPropertyId,
	el: HTMLElement
): string | null {
	const value = entry.getValue(propertyId);
	if (!value) return null;

	value.renderTo(el, app.renderContext);
	return valueTypeName(value);
}

/**
 * 그리지 않고 값 타입만 본다. 무엇으로 그릴지(평범한 값이냐 알약이냐)를 정하려면 그리기 **전에** 타입을
 * 알아야 한다. 값이 없으면 null 이다.
 */
export function valueTypeOf(entry: BasesEntry, propertyId: BasesPropertyId): string | null {
	const value = entry.getValue(propertyId);

	return value ? valueTypeName(value) : null;
}

/**
 * 네이티브 표는 셀에 값 타입을 심어 숫자를 우측 정렬한다. `Value.type` 은 d.ts 에 static 으로만 선언돼 있어
 * (`@public`) 인스턴스에서 읽으려면 생성자를 거친다 — 비공개 멤버 접근은 아니지만 타입 단언이 필요한 자리다.
 * 못 읽으면 null 이고, 그때는 정렬이 기본값(좌측)으로 남을 뿐이다.
 */
function valueTypeName(value: Value): string | null {
	const constructor = value.constructor as unknown as { type?: unknown };

	return typeof constructor.type === 'string' ? constructor.type.toLowerCase() : null;
}
