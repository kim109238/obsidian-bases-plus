import type { BasesEntry, Value } from 'obsidian';

/**
 * **어떤 줄을 어떤 순서로 그릴지**를 정하는 공용 계층. DOM 을 전혀 모른다 — 입력은 값과 설정,
 * 출력은 계획 객체뿐이라 레이아웃 없는 하네스에서 전부 검증된다.
 *
 * 타임라인(2단계)의 왼쪽 판은 표 그 자체라 이 계획을 그대로 먹고 오른쪽 축·막대만 자기가 그린다.
 * 달력은 재사용처가 아니다 — 자리를 날짜가 정하므로 그룹·페이징을 쓰지 않는다.
 *
 * 뷰가 하는 일은 계획을 요소 풀에 붙이는 것뿐이다. 자르기·순서·페이지 계산이 뷰 안에 남지 않는다.
 */

/**
 * 행 제한 방식. F3(전체 페이징)과 F10(그룹 페이징)이 배타라는 규칙을 **한 값**으로 만들어
 * 잘못된 조합이 표현조차 안 되게 한다(디자인 B1 · 대원칙 "충돌은 설명하지 말고 만들 수 없게 한다").
 */
export type RowLimitMode = 'all' | 'pages' | 'group-top' | 'group-pages';

/** 뷰 옵션 드롭다운에 그대로 쓰는 값 → 화면 문구. 순서가 곧 드롭다운 순서다. */
export const ROW_LIMIT_CHOICES: Record<RowLimitMode, string> = {
	all: 'Show all',
	pages: 'Pages',
	'group-top': 'Top rows per group',
	'group-pages': 'Pages per group',
};

export const ROW_LIMIT_KEY = 'rowLimit';
/**
 * 페이지 크기. 예전에는 슬라이더라 숫자로 저장됐고 지금은 입력칸이라 문자열로 저장된다 —
 * **키는 그대로 두고 두 형태를 모두 읽는다.** 기존 `.base` 의 `pageSize: 30` 이 그대로 동작해야 한다.
 */
export const PAGE_SIZE_KEY = 'pageSize';
/** F9·F10 이 공유하는 숫자. 다른 것은 남은 행에 닿는 방법뿐이다 — 펼치기냐 넘기기냐(B1). */
export const GROUP_SIZE_KEY = 'groupSize';
/** 페이징 자체를 끄던 예전 스위치. 이제는 읽기 호환으로만 남는다. */
export const LIMIT_ROWS_KEY = 'limitRows';

export const DEFAULT_PAGE_SIZE = 50;
/** 이보다 작은 값은 값이 없는 것으로 본다 — 0 이나 음수로 표가 비는 상태를 만들지 않는다. */
export const MIN_PAGE_SIZE = 1;

/** 그룹 조작·수동 순서가 `.base` 에 쓰는 자리. 전부 예약 이름을 비껴간다(목록값 order 함정 A). */
export const MANUAL_ORDER_KEY = 'manualOrder';
export const MANUAL_ORDER_ENABLED_KEY = 'manualOrderEnabled';
/**
 * 그룹 수동 순서는 행 수동 순서와 **독립된 옵션**이다(마스터 추가 요구 2026-08-08).
 * 꺼져 있으면(기본) 그룹 순서는 목록값 순서 → 쿼리 순서를 따르고 그룹 손잡이도 뜨지 않는다 —
 * 예전에 끌어 저장해 둔 `groupOrder` 가 새 그룹 기준의 값 순서를 덮어쓰지 않게 하는 것이 이 분리의 핵심이다.
 */
export const GROUP_ORDER_ENABLED_KEY = 'groupOrderEnabled';
export const GROUP_ORDER_KEY = 'groupOrder';
export const COLLAPSED_GROUPS_KEY = 'collapsedGroups';

/** 뷰 config 를 읽는 데 필요한 최소 표면. `BasesViewConfig` 가 아직 안 붙었을 수 있어 undefined 를 받는다. */
export interface ConfigReader {
	get(key: string): unknown;
}

/** 컨트롤러가 준 원본 그룹. `BasesEntryGroup` 에서 우리가 쓰는 것만 추린 모양이다. */
export interface SourceGroup {
	key: Value | null;
	hasKey: boolean;
	entries: BasesEntry[];
}

export interface PagerState {
	/** 1부터 센다 — 화면에 그대로 나오는 숫자다. */
	page: number;
	pageCount: number;
}

export interface PlanGroup {
	/**
	 * 접힘·순서 저장이 이 문자열로 그룹을 식별한다(D2). 그룹 기준이 없으면 null 이라 헤딩을 그리지 않는다.
	 * 값이 비어 있는 묶음은 빈 문자열이다 — `.base` 에 사람이 읽을 수 있는 형태로 남는다.
	 */
	id: string | null;
	key: Value | null;
	hasKey: boolean;
	/** 지금 화면에 그릴 행. 접힌 그룹도 채워 둔다 — 요소를 지우지 않고 감추기 때문이다(D2·성2). */
	entries: BasesEntry[];
	/** 자르기 전 그룹의 실제 행 수. `Show all (N)` 괄호 안과 헤딩 오른쪽 숫자가 이 값이다(D1·D3). */
	total: number;
	collapsed: boolean;
	/** F9 에서 잘렸고 아직 펼치지 않았다 — 그룹 푸터에 `Show all (N)` 이 선다. */
	truncated: boolean;
	/** F10 의 그룹별 페이저. 한 페이지에 다 들어가면 null 이라 페이저를 만들지 않는다(D4). */
	pager: PagerState | null;
}

export interface RowPlan {
	groups: PlanGroup[];
	/** F3 의 뷰 페이저. null 이면 푸터 바 자체를 만들지 않는다 — 빈 30px 띠를 남기지 않는다(B2). */
	pager: PagerState | null;
	/** 안내 띠 문구. null 이면 띠가 없다(A4). */
	notice: string | null;
	/** 행 순서 모드가 실제로 살아 있는지 — 행 손잡이를 그릴지 정한다(C1). */
	ordering: boolean;
	/** 그룹 순서 모드. 행과 독립이라 한쪽만 켜질 수 있고, 여백 열은 둘 중 하나만 켜져도 생긴다. */
	groupOrdering: boolean;
	/** 지금 유효한 뷰 페이지(1부터). 범위를 넘던 페이지가 당겨진 결과가 여기 담긴다(B4). */
	page: number;
	/**
	 * 자르기 **전** 전체 행의 경로 — 지금 순서 그대로다. 수동 순서를 저장할 때 이 목록의 자리만 갈아 끼워
	 * 페이지·그룹 밖 행의 상대 위치를 지킨다(C4).
	 */
	order: string[];
}

export interface RowPlanInput {
	entries: BasesEntry[];
	/** 그룹 기준이 없으면 빈 배열. */
	groups: SourceGroup[];
	limit: RowLimitMode;
	pageSize: number;
	groupSize: number;
	/** 사용자가 보고 있던 페이지. 범위를 넘으면 계획이 당겨서 돌려준다. */
	page: number;
	/** 그룹 id → 그 그룹에서 보고 있던 페이지. */
	groupPages: Map<string, number>;
	/** F9 에서 `Show all` 을 눌러 펼쳐 둔 그룹. 저장하지 않는다 — 이번에 더 보려는 것뿐이다(D3). */
	expandedGroups: Set<string>;
	collapsedGroups: Set<string>;
	/** `Manual order` 뷰 옵션. 정렬이 걸려 있으면 켜져 있어도 손잡이는 나오지 않는다(C1). */
	manualOrder: boolean;
	/**
	 * `Group manual order` 뷰 옵션. 꺼져 있으면 저장된 `groupOrder` 를 **읽지 않는다** —
	 * 지우지는 않으므로 다시 켜면 그대로 돌아온다(정렬을 켰다 껐을 때의 행 순서와 같은 규칙 · C4).
	 */
	groupManualOrder: boolean;
	sorted: boolean;
	/** 저장된 행 순서(파일 경로). 여기 없는 행은 뒤에 쿼리 순서대로 붙는다(C4). */
	rowOrder: string[];
	/** 저장된 그룹 순서(그룹 키 문자열). */
	groupOrder: string[];
	/**
	 * 목록값 순서 — 그 열이 **정렬 열일 때만** 넘어온다(F4). 값 문자열의 순위를 돌려주고,
	 * 순서 목록에 없으면 null 이라 맨 뒤로 간다.
	 */
	rowRank: ((entry: BasesEntry) => RankResult) | null;
	/** 목록값 순서 — 그 열이 **그룹 기준일 때만** 넘어온다. */
	groupRank: ((id: string) => number | null) | null;
	/**
	 * 툴바 `Group by` 의 방향이 `DESC`(Z-A)인지. **값 순서로 세운 그룹 차례를 뒤집는 데 쓴다** —
	 * 행 정렬의 `rankDescending` 과 같은 이유다(F4): 툴바에 오름·내림 표시가 남아 있는데 방향을 바꿔도
	 * 아무 일이 없으면 **화면의 표시가 거짓말**이 된다. 임의 순서에 `DESC` 가 가질 수 있는 뜻은 역순뿐이다.
	 */
	groupDescending: boolean;
	/** 정렬 방향이 `DESC` 면 목록값 순서를 뒤집는다 — 툴바 표시가 거짓말이 되지 않게(F4). */
	rankDescending: boolean;
}

export interface RankResult {
	/** 순서 목록에서의 자리. 없으면 null. */
	rank: number | null;
	/** 순위가 없는 값끼리는 사전순으로 줄 세운다(F5). */
	text: string;
}

const NOTICE_SORT_ACTIVE =
	'Manual order is paused while a sort is active. Clear the sort to reorder rows.';
const NOTICE_GROUP_PAGING_NEEDS_GROUP =
	'Group paging needs a group. Choose Group by in the toolbar.';

/**
 * 저장된 뷰 설정 → 행 제한 방식. **기존 `.base` 를 읽는 규칙이 전부 여기 모여 있다.**
 *
 * 기본이 `Show all` 로 바뀌었으므로(B1), 예전 뷰가 조용히 제한을 잃지 않게 세 갈래로 받는다.
 * `limitRows: true` 를 `Pages` 로 읽는 것은 명세 문언(`pageSize` 가 함께 있을 때)에서 넓힌 지점이다 —
 * 문언대로면 명시적으로 켠 제한이 풀려 필터 없는 base 가 볼트 전체를 그린다(성1 이 막으려는 상태).
 */
export function resolveRowLimit(config: ConfigReader | undefined): RowLimitMode {
	if (!config) return 'all';

	const stored = config.get(ROW_LIMIT_KEY);
	if (typeof stored === 'string' && stored in ROW_LIMIT_CHOICES) return stored as RowLimitMode;

	const legacyToggle = config.get(LIMIT_ROWS_KEY);
	if (legacyToggle === false) return 'all';
	if (legacyToggle === true) return 'pages';

	return hasValue(config.get(PAGE_SIZE_KEY)) ? 'pages' : 'all';
}

/** 비었거나 공백뿐이면 설정이 없는 것으로 본다 — 사용자가 입력칸을 비워 둔 상태다. */
function hasValue(value: unknown): boolean {
	if (value === undefined || value === null) return false;

	return typeof value === 'string' ? value.trim() !== '' : true;
}

/**
 * 저장된 페이지 크기를 숫자로 되돌린다. 슬라이더 시절 값은 숫자, 입력칸 값은 문자열이라 둘 다 받는다.
 * 비었거나 숫자가 아니거나 하한 미만이면 `fallback` — 뷰에서는 설정 탭의 기본값이 그 자리에 온다(T30).
 * 사용자가 손으로 고치는 `.base` 에서 오는 값이라 관대하게 읽는다.
 */
export function resolvePageSize(value: unknown, fallback: number = DEFAULT_PAGE_SIZE): number {
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;

	return Number.isFinite(parsed) && parsed >= MIN_PAGE_SIZE ? Math.floor(parsed) : fallback;
}

/**
 * 저장된 문자열 배열. 사용자가 손으로 고치는 `.base` 에서 오므로 배열이 아니면 없는 것으로 본다
 * (`resolvePageSize` 와 같은 관대한 읽기 · F5).
 */
export function readStringList(config: ConfigReader | undefined, key: string): string[] {
	const stored = config?.get(key);
	if (!Array.isArray(stored)) return [];

	return stored.filter((item): item is string => typeof item === 'string');
}

/** 그룹을 저장·식별하는 문자열. 값이 없는 묶음은 빈 문자열이라 `.base` 에 읽을 수 있는 형태로 남는다. */
export function groupIdOf(group: SourceGroup): string {
	if (!group.hasKey || !group.key) return '';

	try {
		return String(group.key);
	} catch (error) {
		console.error('Bases Plus: could not read the group key.', error);
		return '';
	}
}

/**
 * 계획을 세운다. 계산 순서가 고정이고 그 순서가 곧 규칙이다.
 *
 * 1. 수동 순서 — `manualOrder && !sorted` 일 때만
 * 2. 목록값 순서 — 그 열이 정렬 열일 때만
 * 3. 그룹 나누기·그룹 순서
 * 4. 자르기 — `pages` 만 **전체를 먼저 자르고** 그 결과를 그룹에 나눈다(네이티브와 같은 순서 · B4).
 *    나머지 그룹 계열은 그룹으로 나눈 뒤 그룹마다 자른다
 */
export function buildRowPlan(input: RowPlanInput): RowPlan {
	const ordering = input.manualOrder && !input.sorted;
	// 그룹 순서에는 정렬 게이트가 없다 — 그룹 순서는 행 정렬과 무관한 축이다(D5).
	const groupOrdering = input.groupManualOrder;
	const hasGroupBy = input.groups.length > 0;

	let entries = ordering ? applyRowOrder(input.entries, input.rowOrder) : input.entries.slice();
	if (input.rowRank) entries = applyValueOrder(entries, input.rowRank, input.rankDescending);

	const rank = new Map<BasesEntry, number>();
	entries.forEach((entry, index) => rank.set(entry, index));

	// `pages` 는 전체 목록을 먼저 자른다 — 그다음 그룹에 나눠 담는다.
	const paged = input.limit === 'pages' ? pageOf(entries.length, input.pageSize, input.page) : null;
	const visible = paged ? entries.slice((paged.page - 1) * input.pageSize, paged.page * input.pageSize) : entries;

	const groups = hasGroupBy
		? splitGroups(input, visible, rank)
		: [flatGroup(input, visible)];

	return {
		groups,
		pager: paged && paged.pageCount > 1 ? paged : null,
		notice: noticeFor(input, hasGroupBy),
		ordering,
		groupOrdering: groupOrdering && hasGroupBy,
		page: paged ? paged.page : 1,
		order: entries.map((entry) => entry.file?.path ?? ''),
	};
}

/**
 * 그룹 기준이 없을 때. 헤딩 없이 평평하게 그리되 **그룹 계열 자르기는 그대로 먹인다** —
 * `Top rows per group` 은 "앞 N행만"으로, `Pages per group` 은 뷰 페이저와 같게 퇴화한다(설계 메모 5-④).
 */
function flatGroup(input: RowPlanInput, visible: BasesEntry[]): PlanGroup {
	return cutGroup(input, { id: null, key: null, hasKey: false, entries: visible }, visible.length);
}

function splitGroups(
	input: RowPlanInput,
	visible: BasesEntry[],
	rank: Map<BasesEntry, number>
): PlanGroup[] {
	const allowed = new Set(visible);
	const kept: { source: SourceGroup; id: string; entries: BasesEntry[] }[] = [];

	for (const group of input.groups) {
		// 수동 순서·목록값 순서가 정한 자리를 그룹 안에서도 지킨다 — 원본 그룹의 순서가 아니라 우리 순위로 줄 세운다.
		const entries = group.entries
			.filter((entry) => allowed.has(entry))
			.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

		if (entries.length === 0) continue;

		kept.push({ source: group, id: groupIdOf(group), entries });
	}

	sortGroups(kept, input);

	return kept.map((item) =>
		cutGroup(
			input,
			{ id: item.id, key: item.source.key, hasKey: item.source.hasKey, entries: item.entries },
			item.entries.length
		)
	);
}

/**
 * 그룹 순서는 3단이다 — 저장된 `groupOrder` → 목록값 순서 → 쿼리 순서.
 * 사용자가 직접 끌어 만든 순서가 이기고, 나머지를 값 순서가 채운다(설계 메모 5-③).
 */
function sortGroups(
	kept: { source: SourceGroup; id: string; entries: BasesEntry[] }[],
	input: RowPlanInput
): void {
	const manual = new Map<string, number>();
	// **꺼져 있으면 저장값을 아예 읽지 않는다.** 예전 그룹 기준에서 끌어 둔 순서가 살아남아
	// 새 기준의 값 순서를 덮는 상태를 구조에서 없앤다(마스터 24번 피드백).
	if (input.groupManualOrder) {
		input.groupOrder.forEach((id, index) => {
			if (!manual.has(id)) manual.set(id, index);
		});
	}

	if (manual.size === 0 && !input.groupRank) return;

	const original = new Map<string, number>();
	kept.forEach((item, index) => original.set(item.id, index));

	/*
	 * 방향이 `DESC` 면 값 순서로 세운 차례를 통째로 뒤집는다 — 행 정렬과 같은 계약이다(F4).
	 *
	 * **수동으로 끌어 둔 순서에는 걸지 않는다.** `groupOrder` 는 사용자가 만든 최종 배치 그 자체라,
	 * 방향으로 다시 뒤집으면 방금 놓은 자리와 싸운다. 값 순서는 "규칙이 만든 차례" 라서 방향이 지배하고,
	 * 수동 순서는 "손으로 만든 배치" 라서 그대로 둔다 — 뒤집고 싶으면 끌면 된다.
	 */
	const reverse = input.groupDescending && !!input.groupRank && manual.size === 0;

	kept.sort((a, b) => {
		const tier = tierOf(a.id) - tierOf(b.id);
		if (tier !== 0) return tier;

		const within = withinTier(a.id) - withinTier(b.id);
		if (within !== 0) return within;

		/*
		 * 순위가 없는 그룹(값 여러 개를 쓰는 조합 키)은 **맨 뒤에 사전순**이다 — 행 값 순서와 같은 규칙(F5).
		 * 쿼리 순서로 두면 그 차례가 툴바 방향에 따라 저 혼자 뒤집혀, 방향을 바꿨을 때 위쪽은 그대로인데
		 * 아래쪽만 움직이는 "부분 반영"이 된다(마스터 2차 C 증상의 실체).
		 */
		if (input.groupRank && tierOf(a.id) === 2) {
			const byText = a.id.localeCompare(b.id);
			if (byText !== 0) return byText;
		}

		return (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0);
	});

	if (reverse) kept.reverse();

	function tierOf(id: string): number {
		if (manual.has(id)) return 0;
		if (input.groupRank && input.groupRank(id) !== null) return 1;

		return 2;
	}

	function withinTier(id: string): number {
		const manualIndex = manual.get(id);
		if (manualIndex !== undefined) return manualIndex;

		return input.groupRank ? input.groupRank(id) ?? 0 : 0;
	}
}

/** 그룹 하나를 모드에 맞춰 자른다. `total` 은 자르기 전 값이라 헤딩 숫자·`Show all (N)` 이 실제 크기를 말한다. */
function cutGroup(
	input: RowPlanInput,
	group: { id: string | null; key: Value | null; hasKey: boolean; entries: BasesEntry[] },
	total: number
): PlanGroup {
	const id = group.id;
	const collapsed = id !== null && input.collapsedGroups.has(id);
	const base: PlanGroup = {
		id,
		key: group.key,
		hasKey: group.hasKey,
		entries: group.entries,
		total,
		collapsed,
		truncated: false,
		pager: null,
	};

	if (input.limit === 'group-top') {
		// 펼쳐 둔 그룹은 자르지 않는다. 펼침은 저장하지 않아 다시 열면 다시 접힌다(D3).
		if (id !== null && input.expandedGroups.has(id)) return base;
		if (total <= input.groupSize) return base;

		return { ...base, entries: group.entries.slice(0, input.groupSize), truncated: true };
	}

	if (input.limit === 'group-pages') {
		const pager = pageOf(total, input.groupSize, id === null ? 1 : input.groupPages.get(id) ?? 1);
		const start = (pager.page - 1) * input.groupSize;

		return {
			...base,
			entries: group.entries.slice(start, start + input.groupSize),
			// 한 페이지에 다 들어가면 페이저를 만들지 않는다(D4).
			pager: pager.pageCount > 1 ? pager : null,
		};
	}

	return base;
}

/**
 * 페이지 수와 유효한 현재 페이지. 페이지 크기를 줄이거나 볼트 변경으로 행이 사라져 범위를 넘으면
 * **마지막 페이지로 당긴다** — 빈 페이지를 보여 주지 않는다(B4).
 */
export function pageOf(total: number, size: number, page: number): PagerState {
	const pageCount = Math.max(1, Math.ceil(total / Math.max(1, size)));

	return { page: Math.min(Math.max(1, Math.floor(page) || 1), pageCount), pageCount };
}

/**
 * 저장된 순서대로 앞에 세우고, 저장에 없는 행은 **뒤에 쿼리 순서대로** 붙인다(C4).
 * 같은 경로가 여러 번 저장돼 있어도 첫 자리만 쓴다 — 손으로 고친 `.base` 에서 올 수 있다.
 */
export function applyRowOrder(entries: BasesEntry[], order: string[]): BasesEntry[] {
	if (order.length === 0) return entries.slice();

	const rank = new Map<string, number>();
	order.forEach((path, index) => {
		if (!rank.has(path)) rank.set(path, index);
	});

	const known: { entry: BasesEntry; rank: number }[] = [];
	const rest: BasesEntry[] = [];

	for (const entry of entries) {
		const at = rank.get(entry.file?.path ?? '');
		if (at === undefined) rest.push(entry);
		else known.push({ entry, rank: at });
	}

	known.sort((a, b) => a.rank - b.rank);

	return known.map((item) => item.entry).concat(rest);
}

/**
 * 목록값 순서를 행 정렬에 먹인다. 순서 목록에 없는 값은 **맨 뒤에 사전순**이다(F5) —
 * 나중에 생긴 값이 조용히 맨 앞에 끼어들지 않게. `DESC` 는 전체를 뒤집는다(F4).
 */
export function applyValueOrder(
	entries: BasesEntry[],
	rankOf: (entry: BasesEntry) => RankResult,
	descending: boolean
): BasesEntry[] {
	const decorated = entries.map((entry, index) => ({ entry, index, ...rankOf(entry) }));

	decorated.sort((a, b) => {
		if (a.rank !== null && b.rank !== null) return a.rank - b.rank || a.index - b.index;
		if (a.rank !== null) return -1;
		if (b.rank !== null) return 1;

		return a.text.localeCompare(b.text) || a.index - b.index;
	});

	const sorted = decorated.map((item) => item.entry);

	return descending ? sorted.reverse() : sorted;
}

/**
 * 안내 띠는 기능이 조건 때문에 지금 동작하지 않을 때만 나온다. 둘 다 나올 일은 없다 — 첫째가 이긴다(A4).
 * 오류가 아니라 상태 설명이라 사용자가 뭘 잘못한 것이 아니다.
 */
function noticeFor(input: RowPlanInput, hasGroupBy: boolean): string | null {
	if (input.manualOrder && input.sorted) return NOTICE_SORT_ACTIVE;
	if (input.limit === 'group-pages' && !hasGroupBy) return NOTICE_GROUP_PAGING_NEEDS_GROUP;

	return null;
}
