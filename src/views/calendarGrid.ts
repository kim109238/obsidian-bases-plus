/**
 * 달력 그리드의 **계산만** 맡는 층. DOM 을 전혀 모른다 — 입력은 날짜와 항목, 출력은 칸과 줄 배정뿐이라
 * 레이아웃 없는 하네스에서 전부 검증된다(`rowPlan.ts`·`timelineAxis.ts` 와 같은 경계다).
 *
 * 이 층이 지키는 규칙은 둘이다.
 * ① **여러 날 막대는 그 주 내내 같은 줄에 있다** — 칸마다 따로 쌓으면 계단처럼 어긋나 하나의 기간으로
 *    안 읽힌다(디자인 C3).
 * ② **칸은 넘치면 접는다, 늘어나지 않는다** — 넘친 수만 세어 주고 자르는 것은 뷰가 한다.
 *    펼침이 같은 계산을 두 번 하지 않게, 줄은 **전부** 돌려주고 `hidden` 만 따로 센다.
 */
import { atMidnight } from './timelineAxis';

export type CalendarMode = 'month' | 'week';

/** 뷰 옵션 `View` 의 선택지. 우리 컨트롤 이름이라 영어다(확정 D3-B). */
export const CALENDAR_MODE_CHOICES: Record<CalendarMode, string> = {
	month: 'Month',
	week: 'Week',
};

/** 뷰 옵션 `Week starts on` 의 선택지. 나머지 요일 시작은 실사용이 없다(디자인 B3). */
export const WEEK_START_CHOICES: Record<string, string> = {
	'0': 'Sunday',
	'1': 'Monday',
};

export type TaskStatus = 'todo' | 'done' | 'cancelled';

export interface CalendarDay {
	date: Date;
	/** 이번 달 밖의 날. 주 보기에서는 늘 false — 기준이 되는 달이 없다. */
	outside: boolean;
	weekend: boolean;
	today: boolean;
}

export interface CalendarPeriod {
	mode: CalendarMode;
	/** 이 기간을 대표하는 날짜(달의 1일 · 주의 첫날). 이동 버튼이 이 값을 옮긴다. */
	anchor: Date;
	weeks: CalendarDay[][];
	/** 머리에 쓰는 기간 이름 — **날짜 표기라 화면 언어를 따른다**(확정 D3-B). */
	title: string;
}

/** 달력에 서는 것 하나. 파일과 태스크가 **같은 자격**이라 한 타입이다(확정 4). */
export interface CalendarItem {
	id: string;
	kind: 'file' | 'task';
	start: Date;
	/** 마지막 날(포함). 하루짜리면 start 와 같다. */
	end: Date;
	label: string;
	/** 태스크만. 파일이면 null 이다. */
	status: TaskStatus | null;
	/** 쿼리 순서 — 이름이 같을 때 순서가 갱신마다 흔들리지 않게 하는 마지막 기준. */
	index: number;
}

/**
 * 항목 하나가 그 주에서 차지하는 자리. **칸이 아니라 주가 단위다** — 여러 날 막대가 한 요소로
 * 걸쳐야 칸 경계에서 끊기지 않고, 같은 줄에 있는 것들이 같은 높이를 나눠 갖는다(마스터 1차 16·22번).
 */
export interface CalendarPlacement {
	item: CalendarItem;
	/** 이 주에서 차지하는 칸 범위(0~6, 양끝 포함). */
	from: number;
	to: number;
	lane: number;
	/** 그 주에서 시작하지 않는다 = 왼쪽이 잘렸다. 끊긴 변의 모서리를 각지게 만든다(C1). */
	clippedStart: boolean;
	clippedEnd: boolean;
}

export interface CalendarWeekLayout {
	days: CalendarDay[];
	/** 줄 번호 순으로 정렬돼 있고 **자르지 않은 전량**이다. 자르는 것은 뷰가 한다(확정 2). */
	placements: CalendarPlacement[];
	/** 칸별로 `Items per day` 를 넘겨 접힌 항목 수. */
	hidden: number[];
	/** 이 주가 쓰는 줄 수(자르기 전). */
	laneCount: number;
}

const WEEK_DAYS = 7;

export function startOfWeek(date: Date, weekStart: number): Date {
	const at = atMidnight(date);
	const back = (at.getDay() - weekStart + WEEK_DAYS) % WEEK_DAYS;

	return new Date(at.getFullYear(), at.getMonth(), at.getDate() - back);
}

/**
 * 이동 버튼이 옮기는 자리. **기간의 시작으로 정규화**해서 옮긴다 — 1월 31일에서 한 달을 더하면
 * 3월 3일이 되는 달력 산술 사고를 구조적으로 막는다.
 */
export function shiftPeriod(anchor: Date, mode: CalendarMode, step: number, weekStart: number): Date {
	const at = atMidnight(anchor);

	if (mode === 'week') {
		const first = startOfWeek(at, weekStart);

		return new Date(first.getFullYear(), first.getMonth(), first.getDate() + step * WEEK_DAYS);
	}

	return new Date(at.getFullYear(), at.getMonth() + step, 1);
}

/**
 * 기간 하나를 칸으로 편다.
 *
 * 월 보기의 줄 수는 **그 달이 요구하는 만큼**이다(4~6). 늘 6줄로 고정하면 8월처럼 5줄이면 되는 달에
 * 이번 달 밖 칸만 있는 줄이 하나 더 붙어 임베드 높이가 90px 더 든다(A4 — 잘림이 이 뷰의 위험이다).
 */
export function buildPeriod(
	anchor: Date,
	mode: CalendarMode,
	weekStart: number,
	today: Date,
	locale: string
): CalendarPeriod {
	const at = atMidnight(anchor);

	if (mode === 'week') {
		const first = startOfWeek(at, weekStart);

		return {
			mode,
			anchor: first,
			weeks: [daysOf(first, WEEK_DAYS, null, today)],
			title: weekTitle(first, addDays(first, WEEK_DAYS - 1), locale),
		};
	}

	const firstOfMonth = new Date(at.getFullYear(), at.getMonth(), 1);
	const gridStart = startOfWeek(firstOfMonth, weekStart);
	const lead = dayDiff(gridStart, firstOfMonth);
	const monthLength = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
	const weekCount = Math.ceil((lead + monthLength) / WEEK_DAYS);
	const days = daysOf(gridStart, weekCount * WEEK_DAYS, firstOfMonth.getMonth(), today);
	const weeks: CalendarDay[][] = [];

	for (let i = 0; i < weekCount; i++) {
		weeks.push(days.slice(i * WEEK_DAYS, (i + 1) * WEEK_DAYS));
	}

	return { mode, anchor: firstOfMonth, weeks, title: monthTitle(firstOfMonth, locale) };
}

/**
 * 한 주를 채운다. **여러 날 막대가 먼저 줄을 잡고**(시작이 이른 것부터, 같으면 긴 것부터)
 * 남은 줄에 하루짜리와 태스크가 이름순으로 들어간다(C3).
 *
 * 돌려주는 것은 칸별 스택이 아니라 **주 전체의 자리 목록**이다. 칸마다 쌓으면 같은 줄의 높이가 칸마다
 * 따로 정해져 막대가 어긋난다 — 마스터 1차 16·22번이 지적한 그 증상이다. 줄이 곧 그리드의 행이 되면
 * 높이가 구조적으로 하나가 된다.
 *
 * @param limit `Items per day`. 넘친 수는 `hidden` 에 담기고 자르는 것은 뷰가 한다 —
 *   펼친 줄은 같은 계산 결과를 자르지 않고 그대로 쓰기 때문이다.
 */
export function layoutWeek(days: CalendarDay[], items: CalendarItem[], limit: number): CalendarWeekLayout {
	const hidden = days.map(() => 0);
	if (days.length === 0) return { days, placements: [], hidden, laneCount: 0 };

	const first = days[0].date;
	const last = days[days.length - 1].date;
	const within = items.filter((item) => item.end >= first && item.start <= last);
	const lanes: boolean[][] = days.map(() => []);
	const placements: CalendarPlacement[] = [];

	const place = (item: CalendarItem, from: number, to: number): void => {
		let lane = 0;
		while (occupied(lanes, from, to, lane)) lane++;

		for (let col = from; col <= to; col++) lanes[col][lane] = true;
		placements.push({
			item,
			from,
			to,
			lane,
			clippedStart: item.start < days[from].date,
			clippedEnd: item.end > days[to].date,
		});
	};

	for (const item of within.filter(isMultiDay).sort(compareSpans)) {
		place(item, Math.max(0, dayDiff(first, item.start)), Math.min(days.length - 1, dayDiff(first, item.end)));
	}

	// 하루짜리 파일과 태스크는 섞어 쌓는다 — 태스크를 늘 뒤로 보내면 바쁜 날에 한 줄도 안 보인다(확정 4).
	for (const item of within.filter((item) => !isMultiDay(item)).sort(compareSingles)) {
		const col = dayDiff(first, item.start);
		if (col < 0 || col >= days.length) continue;

		place(item, col, col);
	}

	placements.sort((a, b) => a.lane - b.lane || a.from - b.from);

	const visible = Math.max(1, Math.floor(limit) || 1);
	let laneCount = 0;

	for (const placement of placements) {
		laneCount = Math.max(laneCount, placement.lane + 1);
		if (placement.lane < visible) continue;

		for (let col = placement.from; col <= placement.to; col++) hidden[col]++;
	}

	return { days, placements, hidden, laneCount };
}

/**
 * 항목을 줄별로 나눠 담는다. `layoutWeek` 은 자기 주에 걸치는 것만 보면 되는데, 줄마다 전체 목록을
 * 훑으면 같은 일을 주 수만큼 되풀이한다 — 3000행에서 재렌더가 한 프레임에 닿는 원인이었다(성1).
 * 한 번 훑어 담아 두면 그 뒤로는 자기 줄 몫만 본다.
 */
export function bucketByWeek(weeks: CalendarDay[][], items: CalendarItem[]): CalendarItem[][] {
	const buckets: CalendarItem[][] = weeks.map(() => []);
	if (weeks.length === 0) return buckets;

	const first = weeks[0][0].date;
	const last = weeks.length - 1;

	for (const item of items) {
		const from = Math.max(0, Math.floor(dayDiff(first, item.start) / 7));
		const to = Math.min(last, Math.floor(dayDiff(first, item.end) / 7));

		for (let week = from; week <= to; week++) buckets[week].push(item);
	}

	return buckets;
}

/** 자정 기준 일련번호 차. **UTC 로 환산해 뺀다** — 서머타임 구간에서 하루가 23시간이라 나눗셈이 밀린다. */
export function dayDiff(from: Date, to: Date): number {
	return dayNumber(to) - dayNumber(from);
}

function dayNumber(date: Date): number {
	return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function addDays(date: Date, count: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function daysOf(from: Date, count: number, month: number | null, today: Date): CalendarDay[] {
	const todayNumber = dayNumber(today);
	const out: CalendarDay[] = [];

	for (let i = 0; i < count; i++) {
		const date = addDays(from, i);

		out.push({
			date,
			outside: month !== null && date.getMonth() !== month,
			weekend: isWeekend(date),
			today: dayNumber(date) === todayNumber,
		});
	}

	return out;
}

/** 주말은 토·일이다 — 첫 요일 옵션과 무관하다(무엇이 주말인지는 주가 어디서 시작하든 같다). */
function isWeekend(date: Date): boolean {
	const day = date.getDay();

	return day === 0 || day === 6;
}

function isMultiDay(item: CalendarItem): boolean {
	return dayDiff(item.start, item.end) > 0;
}

function compareSpans(a: CalendarItem, b: CalendarItem): number {
	const start = a.start.getTime() - b.start.getTime();
	if (start !== 0) return start;

	// 같은 날 시작이면 **긴 것이 위**다. 짧은 것이 위에 오면 긴 막대가 아래에서 잘려 보인다.
	const span = dayDiff(b.start, b.end) - dayDiff(a.start, a.end);
	if (span !== 0) return span;

	return compareLabels(a, b);
}

function compareSingles(a: CalendarItem, b: CalendarItem): number {
	return compareLabels(a, b);
}

function compareLabels(a: CalendarItem, b: CalendarItem): number {
	const byLabel = a.label.localeCompare(b.label);
	if (byLabel !== 0) return byLabel;

	return a.index - b.index;
}

function occupied(lanes: boolean[][], from: number, to: number, lane: number): boolean {
	for (let col = from; col <= to; col++) {
		if (lanes[col][lane]) return true;
	}

	return false;
}

/**
 * 기간 이름은 표준 `Intl` 에 맡긴다 — 번역 표를 우리가 지지 않는다(타임라인 축과 같은 규칙).
 */
function monthTitle(date: Date, locale: string): string {
	return format(locale, { year: 'numeric', month: 'long' }, date);
}

/**
 * 주 이름은 시작·끝 두 날짜다. `formatRange` 가 있으면 로케일이 정한 방식으로 이어 주고,
 * 없으면 두 날짜를 en dash 로 잇는다.
 */
function weekTitle(from: Date, to: Date, locale: string): string {
	const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };

	try {
		const formatter = new Intl.DateTimeFormat(locale, options) as unknown as {
			formatRange?: (a: Date, b: Date) => string;
		};
		if (typeof formatter.formatRange === 'function') return formatter.formatRange(from, to);
	} catch {
		// 언어 태그가 이상해도 머리는 서야 한다 — 아래 폴백으로 내려간다.
	}

	return `${format(locale, options, from)} – ${format(locale, options, to)}`;
}

/** 요일 머리 — 첫 요일 옵션에서 시작해 일곱 개. */
export function weekdayNames(weekStart: number, locale: string): string[] {
	// 2026-08-02 는 일요일이다. 여기서부터 세면 어떤 로케일이든 요일 이름만 뽑을 수 있다.
	const sunday = new Date(2026, 7, 2);
	const out: string[] = [];

	for (let i = 0; i < WEEK_DAYS; i++) {
		out.push(format(locale, { weekday: 'short' }, addDays(sunday, (weekStart + i) % WEEK_DAYS)));
	}

	return out;
}

function format(locale: string, options: Intl.DateTimeFormatOptions, date: Date): string {
	try {
		return new Intl.DateTimeFormat(locale, options).format(date);
	} catch {
		return new Intl.DateTimeFormat(undefined, options).format(date);
	}
}
