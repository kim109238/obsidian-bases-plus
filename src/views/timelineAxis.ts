/**
 * 날짜 축의 **계산만** 맡는 층. DOM 을 전혀 모른다 — 입력은 날짜와 배율, 출력은 px 좌표와 문구뿐이라
 * 레이아웃 없는 하네스에서 전부 검증된다(`rowPlan.ts` 와 같은 경계다).
 *
 * 좌표 모델은 하나뿐이다 — **원점 날짜에서 몇 눈금 떨어졌는가**에 눈금 폭을 곱한다.
 * 축의 층·막대·오늘 틴트·드래그 스냅이 전부 이 하나의 함수(`unitOffset`)를 거쳐 서로 어긋날 수 없다.
 */

import { appLanguage } from '../shared/i18n';

/** 눈금이 세는 달력 단위. tm-timeline 과 같은 5종이다(디자인 B1). */
export type TimelineUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * 줌 한 단계 = **달력 단위 + 칸 폭** 한 쌍이다. 단위만으로 단계를 세면 주와 달 사이가 3배 넘게 벌어져
 * 중간이 없다(마스터 1차 15번 — "week, month 에 대해 단계를 2개로 좀더"). 같은 단위에 넓은 칸을 하나 더
 * 두면 **새 달력 단위를 발명하지 않고** 밀도를 절반씩 잇는다.
 *
 * 디자인 B1 이 정한 폭(32·40·56·72·96)은 그대로 두고 `week`·`month` 에 넓은 짝만 더했다.
 * 하루당 px: 32 → 9.1 → 5.7 → 3.2 → 1.8 → 0.8 → 0.3 (단조 감소).
 */
export interface ZoomLevel {
	/** `.base` 에 저장되는 값. 예전 값(`day`·`week`…)이 그대로 살아 있어 기존 뷰가 안 깨진다. */
	id: string;
	unit: TimelineUnit;
	width: number;
}

export const ZOOM_LEVELS: ZoomLevel[] = [
	{ id: 'day', unit: 'day', width: 32 },
	{ id: 'week-wide', unit: 'week', width: 64 },
	{ id: 'week', unit: 'week', width: 40 },
	{ id: 'month-wide', unit: 'month', width: 96 },
	{ id: 'month', unit: 'month', width: 56 },
	{ id: 'quarter', unit: 'quarter', width: 72 },
	{ id: 'year', unit: 'year', width: 96 },
];

export const DEFAULT_ZOOM = ZOOM_LEVELS[0];

/** 저장값 → 단계. 모르는 값이면 기본(일)으로 떨어진다. */
export function zoomLevelOf(value: unknown): ZoomLevel {
	const found = typeof value === 'string' ? ZOOM_LEVELS.find((level) => level.id === value) : undefined;

	return found ?? DEFAULT_ZOOM;
}

/** 축이 이보다 짧으면 눈금이 몇 개 없어 축으로 안 읽힌다 — 데이터가 하루뿐이어도 폭을 준다. */
const MIN_UNIT_COUNT = 14;
/** 데이터 양 끝에 두는 여유 눈금. 막대가 축 경계에 붙어 시작·끝이 잘려 보이지 않게 한다. */
const RANGE_PADDING = 1;

const DAY_MS = 86400000;

export interface AxisRange {
	/** 원점 — 눈금 경계에 맞춰 내린 날짜. x=0 이 이 날짜의 왼쪽 끝이다. */
	origin: Date;
	unit: TimelineUnit;
	/** 눈금 한 칸의 폭. **단위가 아니라 줌 단계**가 정한다(같은 주 단위에 40·64 두 단계가 있다). */
	width: number;
	/** 축에 그리는 눈금 개수. 축 전체 폭 = `unitCount * width`. */
	unitCount: number;
	/** 주 눈금의 시작 요일(0=일). 다른 배율에서는 쓰이지 않는다. */
	weekStart: number;
}

export interface AxisSegment {
	left: number;
	width: number;
	/** 빈 문자열이면 글자를 그리지 않는다 — 칸이 좁아 솎아 낸 자리다(아래 `labelStep`). */
	label: string;
	/** 오늘이 든 칸 — 축 글자를 진하게 올린다(B3). 맨 아래 층에만 선다. */
	today: boolean;
}

export interface AxisTier {
	unit: TimelineUnit;
	/** 맨 아래 층만 열 이름 줄과 같은 30px 이다(A3). */
	last: boolean;
	segments: AxisSegment[];
}

/**
 * 배율별 층 구성(위→아래). **맨 아래가 눈금 단위**고 그 위는 묶음이다(B1).
 */
const TIERS: Record<TimelineUnit, TimelineUnit[]> = {
	day: ['year', 'month', 'day'],
	week: ['year', 'month', 'week'],
	month: ['year', 'quarter', 'month'],
	quarter: ['year', 'quarter'],
	year: ['year'],
};

/** 같은 날 자정으로 내린 복사본. 시각이 붙은 값(`2026-08-06T09:30`)도 같은 칸에 서게 한다. */
export function atMidnight(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 자정 기준 일련번호. **UTC 로 환산해 뺀다** — 서머타임이 든 구간을 `(a - b) / 86400000` 으로 재면
 * 하루가 23시간이라 0.96 이 나와 눈금이 한 칸 밀린다.
 */
function dayNumber(date: Date): number {
	return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function daysInMonth(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** 그 눈금이 시작하는 날짜. 원점 잡기·오늘 틴트·드래그 스냅이 전부 이것을 쓴다. */
export function startOfUnit(date: Date, unit: TimelineUnit, weekStart: number): Date {
	const at = atMidnight(date);

	switch (unit) {
		case 'day':
			return at;
		case 'week': {
			const back = (at.getDay() - weekStart + 7) % 7;
			return new Date(at.getFullYear(), at.getMonth(), at.getDate() - back);
		}
		case 'month':
			return new Date(at.getFullYear(), at.getMonth(), 1);
		case 'quarter':
			return new Date(at.getFullYear(), Math.floor(at.getMonth() / 3) * 3, 1);
		default:
			return new Date(at.getFullYear(), 0, 1);
	}
}

/** 눈금 n 개 뒤의 날짜. 월·분기·년은 일수가 고르지 않아 달력 산술로 더한다. */
export function addUnits(date: Date, unit: TimelineUnit, count: number, weekStart: number): Date {
	const at = startOfUnit(date, unit, weekStart);

	switch (unit) {
		case 'day':
			return new Date(at.getFullYear(), at.getMonth(), at.getDate() + count);
		case 'week':
			return new Date(at.getFullYear(), at.getMonth(), at.getDate() + count * 7);
		case 'month':
			return new Date(at.getFullYear(), at.getMonth() + count, 1);
		case 'quarter':
			return new Date(at.getFullYear(), at.getMonth() + count * 3, 1);
		default:
			return new Date(at.getFullYear() + count, 0, 1);
	}
}

/**
 * 원점에서 몇 눈금 떨어졌는가 — **소수까지** 준다. 막대가 달 중간에서 시작해도 그 자리에 서는 이유다.
 * 이 함수 하나가 축·막대·오늘·스냅의 공통 자로 쓰인다.
 */
export function unitOffset(origin: Date, date: Date, unit: TimelineUnit): number {
	const days = dayNumber(date) - dayNumber(origin);

	if (unit === 'day') return days;
	if (unit === 'week') return days / 7;

	const months =
		(date.getFullYear() - origin.getFullYear()) * 12 + (date.getMonth() - origin.getMonth());
	const within = (date.getDate() - 1) / daysInMonth(date);
	const exact = months + within;

	if (unit === 'month') return exact;
	if (unit === 'quarter') return exact / 3;

	return exact / 12;
}

/** 축 좌표(px). 트랙 안쪽 좌표계이고 원점이 0 이다. */
export function xOf(range: AxisRange, date: Date): number {
	return unitOffset(range.origin, date, range.unit) * range.width;
}

/** 축 좌표 → 날짜. 끝단 드래그가 포인터 위치를 날짜로 되돌릴 때 쓴다. */
export function dateAt(range: AxisRange, x: number): Date {
	const units = x / range.width;
	const whole = Math.floor(units);
	const step = addUnits(range.origin, range.unit, whole, range.weekStart);
	const next = addUnits(range.origin, range.unit, whole + 1, range.weekStart);
	// 눈금 안쪽은 그 눈금이 품은 날 수로 나눈다 — 달마다 길이가 달라 비율로만 되돌릴 수 있다.
	const span = dayNumber(next) - dayNumber(step);
	const into = Math.floor((units - whole) * span);

	return new Date(step.getFullYear(), step.getMonth(), step.getDate() + into);
}

export function axisWidth(range: AxisRange): number {
	return range.unitCount * range.width;
}

/**
 * 데이터가 덮는 기간에서 축 범위를 만든다. **오늘을 반드시 포함한다** — 오늘 표시가 화면 밖에 있으면
 * 그 기능이 없는 것과 같다(B3).
 */
/**
 * @param fillUnits 화면이 요구하는 최소 눈금 수. **축이 화면보다 짧으면 오른쪽에 격자도 행 선도 없는 빈 띠가
 *   남는다** — 임베드에서는 폭이 좁아 안 보이고 base 를 직접 열었을 때만 드러난다(마스터 1차 요청 3번).
 *   데이터가 요구하는 길이와 화면이 요구하는 길이 중 긴 쪽을 쓴다.
 */
export function buildRange(
	dates: Date[],
	level: ZoomLevel,
	weekStart: number,
	today: Date,
	fillUnits = 0
): AxisRange {
	let min = atMidnight(today);
	let max = atMidnight(today);

	for (const date of dates) {
		const at = atMidnight(date);
		if (at < min) min = at;
		if (at > max) max = at;
	}

	const origin = addUnits(min, level.unit, -RANGE_PADDING, weekStart);
	const tail = addUnits(max, level.unit, RANGE_PADDING + 1, weekStart);
	const span = Math.ceil(unitOffset(origin, tail, level.unit));

	return {
		origin,
		unit: level.unit,
		width: level.width,
		unitCount: Math.max(MIN_UNIT_COUNT, span, Math.ceil(fillUnits)),
		weekStart,
	};
}

/**
 * 층을 쌓는다. 맨 아래 층은 눈금 하나가 칸 하나이고, 위 층들은 **아래 층 칸을 묶어** 만든다 —
 * 그래서 위 칸의 경계가 아래 칸 경계와 어긋날 수 없다.
 */
export function buildTiers(range: AxisRange, today: Date, locale: string): AxisTier[] {
	const units = TIERS[range.unit];
	const todayStart = startOfUnit(today, range.unit, range.weekStart).getTime();

	return units.map((tierUnit, index) => {
		const last = index === units.length - 1;
		const segments: AxisSegment[] = [];
		let openBucket = NaN;

		for (let i = 0; i < range.unitCount; i++) {
			const at = addUnits(range.origin, range.unit, i, range.weekStart);
			const bucket = startOfUnit(at, tierUnit, range.weekStart).getTime();
			const previous = segments[segments.length - 1];
			const left = i * range.width;

			// 같은 묶음이 이어지면 앞 칸을 늘린다 — 그래야 "8월" 이 그 달의 모든 날 위에 한 번만 선다.
			// 글자가 아니라 **묶음의 시작 날짜**로 비교한다. 문구가 같은 다른 묶음(해가 다른 같은 달)이 있다.
			if (previous && bucket === openBucket) {
				previous.width = left + range.width - previous.left;
				continue;
			}

			openBucket = bucket;
			segments.push({
				left,
				width: range.width,
				label: labelOf(new Date(bucket), tierUnit, locale),
				today: last && at.getTime() === todayStart,
			});
		}

		thinLabels(segments, last ? range.width : Infinity);

		return { unit: tierUnit, last, segments };
	});
}

/**
 * 칸이 글자보다 좁으면 **몇 칸에 하나씩만** 글자를 남긴다(마스터 1차 15번 — 주 배율에서 시작일이 겹쳤다).
 * 위 층은 칸이 묶음만큼 넓고 글자가 왼쪽에 붙어 남으므로 대상이 아니다.
 *
 * 폭은 재지 않고 글자 수로 어림한다 — 실제로 재려면 층마다 요소를 만들어 레이아웃을 강제해야 하는데,
 * 여기서 필요한 것은 "겹치나 안 겹치나"라는 이진 판단뿐이라 어림으로 충분하다.
 */
function thinLabels(segments: AxisSegment[], slot: number): void {
	if (!Number.isFinite(slot) || segments.length === 0) return;

	let widest = 0;
	for (const segment of segments) widest = Math.max(widest, estimateTextWidth(segment.label));

	const step = Math.max(1, Math.ceil((widest + LABEL_GAP) / slot));
	if (step === 1) return;

	segments.forEach((segment, index) => {
		if (index % step !== 0) segment.label = '';
	});
}

/** 글자 사이에 최소로 남길 틈. 이만큼도 없으면 두 글자가 붙어 한 덩어리로 읽힌다. */
const LABEL_GAP = 8;

/**
 * `--font-ui-smaller`(12px) 기준 어림. 한글·한자·가나는 전각이라 한 글자가 두 배 폭이다.
 * 그래프 축도 같은 자를 쓴다 — 두 축이 다른 어림으로 눈금을 솎으면 같은 글자가 뷰마다 다르게 겹친다.
 */
export function estimateTextWidth(text: string): number {
	let width = 0;
	for (const char of text) width += /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF]/.test(char) ? 12 : 6.5;

	return width;
}

/**
 * 축 문구는 **우리 컨트롤 이름이 아니라 날짜 표기**라 화면 언어를 따른다(확정 D3-B · B2).
 * 표준 `Intl.DateTimeFormat` 에 언어를 넘겨 번역 표를 우리가 지지 않는다.
 *
 * 예외가 둘이다. 일 눈금은 숫자만 필요한데 `{ day: 'numeric' }` 이 한국어에서 `6일` 을 내므로 숫자를
 * 그대로 쓰고(B2 표의 `6`), **분기는 `Intl` 에 아예 없어** 두 갈래로 만든다(`3분기` / `Q3`).
 */
function labelOf(date: Date, unit: TimelineUnit, locale: string): string {
	switch (unit) {
		case 'day':
			return String(date.getDate());
		case 'week':
			return format(locale, { month: 'short', day: 'numeric' }, date);
		case 'month':
			return format(locale, { month: 'short' }, date);
		case 'quarter': {
			const quarter = Math.floor(date.getMonth() / 3) + 1;
			return locale.startsWith('ko') ? `${quarter}분기` : `Q${quarter}`;
		}
		default:
			return format(locale, { year: 'numeric' }, date);
	}
}

function format(locale: string, options: Intl.DateTimeFormatOptions, date: Date): string {
	try {
		return new Intl.DateTimeFormat(locale, options).format(date);
	} catch {
		// 언어 태그가 이상해도 축은 서야 한다 — 기본 로케일로 떨어진다.
		return new Intl.DateTimeFormat(undefined, options).format(date);
	}
}

/**
 * 화면 언어. **감지는 한 곳(`shared/i18n`)에만 둔다** — 공개 `getLanguage()` 는 사용자가 언어를 고르지 않았을 때
 * 시스템 언어로 떨어지는데(1.13.6 app.js 실측 — 저장된 언어 설정이 없으면 시스템 로케일),
 * 저장된 값만 보던 옛 경로는 그때 `en` 이라 **한 화면에서 축은 영어 옵션은 한글**이 된다.
 *
 * 이 이름은 축·달력이 이미 쓰고 있어 그대로 두고 속만 넘긴다.
 */
export function screenLanguage(): string {
	return appLanguage();
}

/**
 * 주 시작 요일(0=일). **옵시디언에는 이 설정이 없다** — 화면 언어에서 파생된다(달력 명세와 같은 판단).
 * `Intl.Locale.getWeekInfo()` 가 있으면 그 값을 쓰고(1=월 … 7=일), 없으면 일요일로 둔다.
 */
export function weekStartFor(locale: string): number {
	// `Intl.Locale` 도 `getWeekInfo()` 도 없는 런타임이 있다 — 생성자부터 능력으로 확인한다.
	const intl = Intl as unknown as {
		Locale?: new (tag: string) => { getWeekInfo?: () => { firstDay?: number } };
	};
	if (typeof intl.Locale !== 'function') return 0;

	try {
		const firstDay = new intl.Locale(locale).getWeekInfo?.()?.firstDay;

		return typeof firstDay === 'number' ? firstDay % 7 : 0;
	} catch {
		return 0;
	}
}
