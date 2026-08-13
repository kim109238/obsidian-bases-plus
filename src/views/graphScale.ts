/**
 * 그래프 축의 **계산만** 맡는 층. DOM 도 옵시디언 API 도 모른다 — 입력은 저장된 값 문자열과 상자 치수,
 * 출력은 축 범위·눈금·경로 문자열뿐이라 레이아웃 없는 하네스에서 전부 검증된다
 * (`timelineAxis.ts`·`calendarGrid.ts` 와 같은 경계다).
 *
 * 좌표 모델은 하나뿐이다 — 값은 축 좌표(시간=ms · 숫자=값 · 범주=등장 순번)로 바뀌고, 화면 자리는
 * `ratioOf` 가 낸 0~1 비율에 플롯 폭·높이를 곱해 얻는다. 축·격자·선·점이 전부 이 하나를 거쳐 어긋날 수 없다.
 */
import { estimateTextWidth } from './timelineAxis';

/** x 축이 값 사이의 거리를 어떻게 읽는가(디자인 B1). y 축은 언제나 숫자다. */
export type AxisKind = 'time' | 'number' | 'category';

export interface AxisTick {
	/** 축 좌표계의 값. 화면 자리는 `ratioOf` 를 거친다. */
	value: number;
	label: string;
}

export interface Axis {
	kind: AxisKind;
	min: number;
	max: number;
	ticks: AxisTick[];
}

/** 점 하나. `slot` 은 **x 순서 목록에서 몇 번째 자리인가**로, 빠진 자리를 알아 선을 끊는 근거가 된다(F1). */
export interface PlotPoint {
	x: number;
	y: number;
	slot: number;
}

/** 날짜와 날짜+시각. 시각이 붙어 있으면 그 시각까지 좌표가 된다 — x 축은 시간 비례라 하루 안도 자리가 갈린다. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** 눈금 글자 사이에 최소로 남길 틈. 이만큼도 없으면 두 글자가 붙어 한 덩어리로 읽힌다(타임라인과 같은 값). */
const LABEL_GAP = 8;
/** x 눈금은 이보다 촘촘해지지 않는다 — 자리부터 이 폭으로 잡고 글자 폭으로 다시 줄인다. */
const MIN_TICK_SLOT = 56;

const DAY_MS = 86400000;

/**
 * 저장 문자열 → 시간 좌표(ms). **`dateText.parseDateText` 를 쓰지 않는다** — 그쪽은 달력·타임라인이
 * 날짜 칸을 정하는 층이라 일부러 하루 단위로 내리는데, 여기서는 시각까지가 자리다.
 */
export function parseAxisDate(text: string): number | null {
	const match = DATE_PATTERN.exec(text.trim());
	if (!match) return null;

	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		Number(match[4] || 0),
		Number(match[5] || 0),
		Number(match[6] || 0)
	);

	return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** 저장 문자열 → 숫자. 빈 값은 숫자가 아니다(`Number('')` 이 0 이라 그냥 넘기면 빈 칸이 0 으로 찍힌다). */
export function parseAxisNumber(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed === '') return null;

	const value = Number(trimmed);

	return Number.isFinite(value) ? value : null;
}

/**
 * x 축 종류를 값이 정한다(B1). **한 종류로 전부 읽히는 경우만 그 종류다** — 셋 중 하나라도 날짜가 아니면
 * 시간 축이 될 수 없다. 포함 판정으로 세는 이유는 빠뜨린 형식이 조용히 잘못된 축을 만들지 않게 하기 위해서다.
 */
export function detectAxisKind(texts: string[]): AxisKind {
	let filled = 0;
	let dates = 0;
	let numbers = 0;

	for (const text of texts) {
		if (text.trim() === '') continue;

		filled++;
		if (parseAxisDate(text) !== null) dates++;
		else if (parseAxisNumber(text) !== null) numbers++;
	}

	if (filled === 0) return 'category';
	if (dates === filled) return 'time';
	if (numbers === filled) return 'number';

	return 'category';
}

/** 범주 목록 — **등장 순서**다(확정 5). 간격이 의미를 갖지 않으므로 순서만이 배치를 정한다. */
export function collectCategories(texts: string[]): string[] {
	const out: string[] = [];

	for (const text of texts) {
		const value = text.trim();
		if (value === '' || out.indexOf(value) !== -1) continue;

		out.push(value);
	}

	return out;
}

/** 값 하나의 축 좌표. 범주는 목록에서의 자리가 좌표다. */
export function axisValueOf(text: string, kind: AxisKind, categories: string[]): number | null {
	if (kind === 'time') return parseAxisDate(text);
	if (kind === 'number') return parseAxisNumber(text);

	const at = categories.indexOf(text.trim());

	return at === -1 ? null : at;
}

/** 축 좌표 → 0~1. 범위가 없는 축(값이 하나뿐)에서는 가운데다 — 점 하나가 왼쪽 벽에 붙지 않게. */
export function ratioOf(axis: Axis, value: number): number {
	if (axis.max === axis.min) return 0.5;

	return (value - axis.min) / (axis.max - axis.min);
}

/**
 * y 축. **0 을 포함할지는 데이터가 정하고**(전부 양수면 0 부터 · 음수가 섞이면 최소·최대를 감싼다),
 * 눈금은 사람이 읽는 수(1·2·5 계열)로 떨어진다. 축의 위 끝은 데이터 최대가 아니라 **맨 위 눈금**이다 —
 * 데이터 최대로 잡으면 맨 위 눈금이 플롯 밖(음수 좌표)에 그려져 범례를 덮는다(B2).
 */
export function buildValueAxis(values: number[], targetTicks: number, locale: string): Axis {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	// 전개 연산자로 `Math.min(...values)` 를 쓰지 않는다 — 항목이 수천 개면 인자 한계에서 터진다(성1).
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}

	// 그릴 값이 하나도 없어도 **축은 선다** — 축까지 없으면 빈 화면이 되어 설정이 안 된 것과 구별되지 않는다(D).
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0;
		max = 1;
	}

	if (min > 0) min = 0;
	if (max < 0) max = 0;
	// 값이 전부 0 이면 범위가 없다 — 축이 한 줄로 무너지지 않게 최소 한 칸을 준다.
	if (max === min) max = min + 1;

	const step = niceStep((max - min) / Math.max(1, targetTicks));
	const from = Math.floor(min / step) * step;
	const count = Math.max(1, Math.ceil((max - from) / step - 1e-9));
	const decimals = decimalsFor(step);
	const ticks: AxisTick[] = [];

	for (let i = 0; i <= count; i++) {
		// 값을 더해 나가면 0.1 을 열 번 더한 자리에서 오차가 눈금 글자에 드러난다 — 언제나 곱으로 만든다.
		const value = from + step * i;
		ticks.push({ value, label: formatNumber(value, decimals, locale) });
	}

	return { kind: 'number', min: from, max: from + step * count, ticks };
}

/**
 * 시간 x 축. 눈금은 **범위를 고르게 나눈 자리**다(목업과 같다) — 값 사이 거리가 곧 화면 거리인 축에서
 * 눈금을 달 경계로 맞추면 첫 칸과 끝 칸만 좁아져 오히려 읽기 어렵다.
 *
 * 문구는 화면 언어를 따른다(`Intl.DateTimeFormat` · B1 — 타임라인 축과 같은 규칙).
 */
export function buildTimeAxis(min: number, max: number, width: number, locale: string): Axis {
	const span = max - min;
	const ticks = fitTicks(width, (count) => {
		const out: AxisTick[] = [];

		for (let i = 0; i < count; i++) {
			const value = count === 1 ? min : min + (span * i) / (count - 1);
			out.push({ value, label: timeLabel(value, span, locale) });
		}

		return out;
	});

	return { kind: 'time', min, max, ticks };
}

/** 숫자 x 축. 자리가 값에 비례하므로 y 와 **같은 1·2·5 눈금**을 쓴다 — 축마다 눈금 규칙이 다르면 안 된다. */
export function buildNumberAxis(values: number[], width: number, locale: string): Axis {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;

	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}

	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0;
		max = 1;
	}
	if (max === min) max = min + 1;

	const budget = Math.max(2, Math.floor(width / MIN_TICK_SLOT));
	const step = niceStep((max - min) / budget);
	const from = Math.floor(min / step) * step;
	const count = Math.max(1, Math.ceil((max - from) / step - 1e-9));
	const decimals = decimalsFor(step);
	const ticks: AxisTick[] = [];

	for (let i = 0; i <= count; i++) {
		const value = from + step * i;
		ticks.push({ value, label: formatNumber(value, decimals, locale) });
	}

	return { kind: 'number', min: from, max: from + step * count, ticks };
}

/**
 * 범주 x 축 — 등장 순서대로 균등 배치(확정 5). 칸이 좁으면 **글자를 기울이지 않고 개수를 줄인다**(B1).
 */
export function buildCategoryAxis(categories: string[], width: number): Axis {
	const max = Math.max(0, categories.length - 1);

	if (categories.length === 0) return { kind: 'category', min: 0, max: 0, ticks: [] };

	const widest = categories.reduce((at, name) => Math.max(at, estimateTextWidth(name)), 0);
	const budget = Math.max(1, Math.floor(width / (widest + LABEL_GAP)));
	const step = Math.max(1, Math.ceil(categories.length / budget));
	const ticks: AxisTick[] = [];

	for (let i = 0; i < categories.length; i += step) {
		ticks.push({ value: i, label: categories[i] });
	}

	return { kind: 'category', min: 0, max, ticks };
}

/**
 * 눈금 개수를 폭에 맞춘다 — **글자가 겹치지 않는 최대 개수**(B1). 폭으로 자리를 잡아 두고, 만든 글자가
 * 실제로 그 자리에 안 들어가면 한 개씩 줄인다. 폭을 재지 않고 글자 수로 어림하는 것은 타임라인과 같은 판단이다.
 */
function fitTicks(width: number, build: (count: number) => AxisTick[]): AxisTick[] {
	let count = Math.max(2, Math.min(8, Math.floor(width / MIN_TICK_SLOT)));
	let ticks = build(count);

	while (count > 2) {
		const widest = ticks.reduce((at, tick) => Math.max(at, estimateTextWidth(tick.label)), 0);
		if ((widest + LABEL_GAP) * count <= width) break;

		count--;
		ticks = build(count);
	}

	return ticks;
}

/**
 * 선 경로. **값이 없는 자리에서 끊는 것이 기본**이다(확정 4) — 자리 번호가 이어지지 않으면 새 조각을 연다.
 * `connect` 면 조각을 하나로 잇는다. 어느 쪽이든 **없는 자리에 점은 찍지 않는다**(F1).
 *
 * @param clip 보이는 가로 구간(px). 창을 잡으면 밖의 점은 버리고 **걸친 선분은 경계에서 끊는다** —
 *   그냥 두면 선이 플롯 밖으로 뻗어 y 눈금 글자와 뷰 바깥까지 덧칠한다.
 * @returns 조각마다 하나씩인 `d` 문자열. 점이 하나뿐인 조각은 선이 아니라 점이므로 경로를 내지 않는다(D).
 */
export function linePaths(
	points: PlotPoint[],
	connect: boolean,
	clip?: { from: number; to: number }
): string[] {
	const out: string[] = [];
	let current: PlotPoint[] = [];
	const flush = (): void => {
		if (current.length === 0) return;

		const pieces = clip ? clipPolyline(current, clip.from, clip.to) : [current];
		for (const piece of pieces) out.push(pathOf(piece));
		current = [];
	};

	for (const point of points) {
		const previous = current[current.length - 1];
		if (previous && !connect && point.slot !== previous.slot + 1) flush();

		current.push(point);
	}

	flush();

	return out.filter((path) => path !== '');
}

/**
 * 폴리라인을 가로 구간 안으로 자른다. 점은 x 오름차순이라 **경계를 지나는 선분마다 만나는 자리를 계산해**
 * 그 자리를 끝점으로 삼는다 — 안 그러면 창 가장자리에서 선이 짧게 끝나 데이터가 없는 것처럼 보인다.
 *
 * 창을 통째로 가로지르는 선분(양쪽 다 밖)도 살린다 — 값 사이가 창보다 넓은 데이터가 그렇다.
 */
function clipPolyline(points: PlotPoint[], from: number, to: number): PlotPoint[][] {
	const inside = (point: PlotPoint): boolean => point.x >= from && point.x <= to;
	const out: PlotPoint[][] = [];
	let current: PlotPoint[] = [];

	points.forEach((point, index) => {
		const previous = index > 0 ? points[index - 1] : null;

		if (inside(point)) {
			// 밖에서 들어온 첫 점이면 경계와 만나는 자리를 먼저 넣는다 — 선이 화면 끝에서 시작한다.
			if (previous && !inside(previous)) current.push(crossing(previous, point, previous.x < from ? from : to));
			current.push(point);
			return;
		}

		if (previous && inside(previous)) {
			current.push(crossing(previous, point, point.x < from ? from : to));
			out.push(current);
			current = [];
			return;
		}

		// 밖 → 밖. 창을 건너뛰는 선분이면 두 경계 사이만 남긴다.
		if (previous && ((previous.x < from && point.x > to) || (previous.x > to && point.x < from))) {
			out.push([crossing(previous, point, from), crossing(previous, point, to)]);
		}
	});

	if (current.length > 0) out.push(current);

	return out;
}

/** 두 점을 잇는 직선이 그 x 에서 갖는 자리. 자리 번호는 뒤 점 것을 물려받는다(끊김 판정은 이미 끝났다). */
function crossing(a: PlotPoint, b: PlotPoint, x: number): PlotPoint {
	const span = b.x - a.x;
	const ratio = span === 0 ? 0 : (x - a.x) / span;

	return { x, y: a.y + (b.y - a.y) * ratio, slot: b.slot };
}

/**
 * 창 — 축에서 **지금 보이는 구간**이다. 전체를 볼 때는 창이 없다(null).
 *
 * @param size 창의 폭(축 좌표 단위). 시간 축은 ms 로 환산해 넘긴다.
 * @param ratio 0=왼쪽 끝 · 1=오른쪽 끝. 스크롤 자리가 이 값이 된다.
 */
export function windowRange(min: number, max: number, size: number, ratio: number): { min: number; max: number } {
	const span = max - min;
	// 창이 데이터보다 넓으면 자를 것이 없다 — 전체를 보여 준다(옵션을 크게 잡아도 화면이 안 비게).
	if (!(size > 0) || size >= span) return { min, max };

	const at = min + (span - size) * Math.min(1, Math.max(0, ratio));

	return { min: at, max: at + size };
}

function pathOf(points: PlotPoint[]): string {
	// 점 하나짜리 조각은 선이 아니다 — 경로를 그리면 `linecap: round` 때문에 점 위에 덧칠된 점이 생긴다.
	if (points.length < 2) return '';

	return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`).join(' ');
}

/**
 * 점을 솎는다 — **점 사이 간격이 점 지름보다 좁아지면** 그 점은 그리지 않는다(확정 3).
 * 그대로 두면 점이 뭉쳐 선이 두꺼운 띠가 되고, 요소 수도 행 수만큼 늘어난다(성1).
 *
 * @param positions x 순으로 정렬된 화면 좌표(px).
 * @returns 자리마다 남길지 여부.
 */
export function thinByGap(positions: number[], minGap: number): boolean[] {
	const keep: boolean[] = [];
	let last = Number.NEGATIVE_INFINITY;

	for (const at of positions) {
		const on = at - last >= minGap;
		keep.push(on);
		if (on) last = at;
	}

	return keep;
}

/** 1·2·5 계열에서 고른 눈금 간격. `0 · 30 · 60 · 90` 이지 `0 · 37 · 74` 가 아니다(B2). */
function niceStep(rough: number): number {
	if (!(rough > 0)) return 1;

	const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
	const normalized = rough / magnitude;
	const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

	return step * magnitude;
}

/** 눈금 간격이 0.25 면 소수 둘째 자리까지 쓴다 — 간격보다 잘게 쓰면 눈금이 시끄럽고, 굵으면 같은 글자가 겹친다. */
function decimalsFor(step: number): number {
	const digits = Math.ceil(-Math.log10(step));

	return Math.min(6, Math.max(0, Number.isFinite(digits) ? digits : 0));
}

function formatNumber(value: number, decimals: number, locale: string): string {
	// 0 에 붙은 음수 부호(`-0`)를 지운다 — 반올림에서만 생기는 값이라 축에 뜨면 오해가 된다.
	const safe = Object.is(value, -0) ? 0 : value;

	try {
		return new Intl.NumberFormat(locale, {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
		}).format(safe);
	} catch (error) {
		return safe.toFixed(decimals);
	}
}

/**
 * 날짜 눈금 문구. 범위에 따라 **필요한 자리만** 쓴다 — 하루 안이면 시각, 한 해 안이면 월·일, 그보다 길면 년·월이다.
 * 자리 수를 줄이지 않으면 눈금이 서로 붙어 개수부터 줄어든다.
 */
function timeLabel(value: number, span: number, locale: string): string {
	const date = new Date(value);

	if (span < 2 * DAY_MS) return format(locale, { hour: 'numeric', minute: '2-digit' }, date);
	if (span < 400 * DAY_MS) return format(locale, { month: 'numeric', day: 'numeric' }, date);

	return format(locale, { year: 'numeric', month: 'short' }, date);
}

function format(locale: string, options: Intl.DateTimeFormatOptions, date: Date): string {
	try {
		return new Intl.DateTimeFormat(locale, options).format(date);
	} catch (error) {
		// 언어 태그가 이상해도 축은 서야 한다 — 기본 로케일로 떨어진다(타임라인과 같은 처리).
		return new Intl.DateTimeFormat(undefined, options).format(date);
	}
}

/** SVG 경로에 넣는 좌표. 소수 셋째 자리 아래는 화면에서 같은 픽셀이라 문자열만 길어진다. */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}
