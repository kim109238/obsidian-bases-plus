import { BasesView, Menu, setIcon } from 'obsidian';
import type {
	BasesAllOptions,
	BasesEntry,
	BasesPropertyId,
	BasesSortConfig,
	BasesViewConfig,
	BasesViewRegistration,
	Plugin,
	BasesEntryGroup,
	QueryController,
} from 'obsidian';
import { renderValue, valueTypeOf } from '../shared/renderValue';
import {
	DEFAULT_OPEN_MODE,
	addOpenItem,
	openModeChoices,
	openTarget,
	resolveOpenMode,
} from '../shared/openTarget';
import type { OpenMode } from '../shared/openTarget';
import { MIN_COLUMN_WIDTH, readColumnWidths, saveColumnWidths } from './columnWidths';
import {
	beginCellEdit,
	isChipProperty,
	isEditableProperty,
	isEditableValueType,
	isListProperty,
	propertyTypeIcon,
	readEditableValue,
	registeredPropertyType,
	renderChipCell,
	renderEmptyDatePlaceholder,
	isTypingProperty,
	resolveEditableKind,
	toggleCheckbox,
} from './cellEditor';
import {
	COLLAPSED_GROUPS_KEY,
	GROUP_ORDER_ENABLED_KEY,
	GROUP_ORDER_KEY,
	GROUP_SIZE_KEY,
	MANUAL_ORDER_ENABLED_KEY,
	MANUAL_ORDER_KEY,
	PAGE_SIZE_KEY,
	ROW_LIMIT_CHOICES,
	ROW_LIMIT_KEY,
	buildRowPlan,
	readStringList,
	resolvePageSize,
	resolveRowLimit,
} from './rowPlan';
import type { PagerState, PlanGroup, RowPlan, SourceGroup } from './rowPlan';
import { createPager } from './pager';
import type { PagerHandle } from './pager';
import { createErrorEl, createNoticeEl, showViewError, syncNoticeEl } from './viewShell';
import { OrderDrag } from './orderDrag';
import type { OrderSlot } from './orderDrag';
import { collectValues, openValueOrderModal, readValueOrder, saveValueOrder } from './valueOrder';
import { appLanguage, t, translateChoices } from '../shared/i18n';

/** `.base` 파일의 `views[].type` 에 그대로 기록되는 값. 바꾸면 기존 `.base` 가 뷰를 못 찾는다. */
export const PLUS_TABLE_VIEW_TYPE = 'bases-plus-table';

/** 뷰 옵션 키 — 툴바에서 고른 값이 `.base` 에 저장된다(D21 · 우리 뷰는 설정 탭 전역값을 보지 않는다). */
const OPEN_MODE_KEY = 'openMode';

/** 표시 속성이 하나도 없을 때 네이티브가 쓰는 기본 열과 같다(`BasesViewConfig.getOrder` 기본값). */
const FILE_NAME_PROPERTY: BasesPropertyId = 'file.name';
/** `file.name` 값은 평문 문자열이라 그대로 그리면 링크가 아니다. 네이티브 표는 이 열만 파일 링크로 그린다. */
const FILE_LINK_PROPERTY: BasesPropertyId = 'file.file';

/** 코어 `renderFileLink` 가 내는 파일 링크. 이름 열에서 이 위를 눌렀을 때만 연다 — 네이티브도 링크에만 반응한다. */
const LINK_SELECTOR = '.internal-link, a';
const HANDLE_SELECTOR = '.bases-plus-order-handle';

export interface PlusCell {
	el: HTMLElement;
	/** 값 마크업만 갱신하는 자리 — 네이티브 셀 렌더러가 `bases-rendered-value` 를 붙이는 요소에 해당한다. */
	valueEl: HTMLElement;
	/** 클릭 시점에 이 셀이 어느 열인지 알아야 한다 — 열이 바뀌어도 셀 요소는 재사용되기 때문이다. */
	property: BasesPropertyId | null;
	/** 마지막으로 그린 값의 타입 — 편집기를 무엇으로 띄울지 정한다. */
	valueType: string | null;
}

export interface PlusRow {
	el: HTMLElement;
	/**
	 * 셀들이 실제로 들어가는 자리. 표에서는 행 요소 자신이지만 **타임라인에서는 왼쪽 판**이다 —
	 * 그 판이 `sticky` 로 남아야 하므로 셀을 감싸는 상자가 한 겹 더 필요하다(타임라인 A2).
	 */
	cellsEl: HTMLElement;
	cells: PlusCell[];
	/** 리스너가 최신 항목을 읽는 통로 — 리스너를 다시 걸지 않기 위해 참조만 갈아끼운다. */
	entry: BasesEntry | null;
	/** 수동 순서 손잡이. 셀들 **뒤에** 있어야 `:first-child` 가 계속 첫 셀을 잡는다(C2 함정). */
	handleEl: HTMLElement;
	/** 지금 이 행이 속한 그룹 — 드래그를 자기 그룹 안으로 가두는 데 쓴다(C4). */
	groupId: string | null;
}

interface PlusHeaderCell {
	el: HTMLElement;
	/**
	 * 여백은 반드시 이 안쪽 요소가 가진다. 헤더 칸(flex 항목)에 padding 을 주면 flex-basis 0 계산에서
	 * 그 여백만큼 폭이 달라져 본문 열과 어긋난다(네이티브도 같은 이유로 라벨을 따로 둔다).
	 */
	labelEl: HTMLElement;
	/** 속성 유형 아이콘. 네이티브도 라벨 안 첫 자리에 둔다(`.bases-table-header-icon`). */
	iconEl: HTMLElement;
	nameEl: HTMLElement;
	/** 열 경계의 드래그 손잡이. */
	resizerEl: HTMLElement;
}

export interface PlusGroupHeading {
	el: HTMLElement;
	/** 접기 화살표. 코어가 파일탐색기·검색결과·속성 헤딩에 전부 쓰는 그 글리프다(D1). */
	toggleEl: HTMLElement;
	/** 그룹 기준 속성 이름. 못 읽으면 감춘다. */
	propertyEl: HTMLElement;
	valueEl: HTMLElement;
	/** 그룹의 실제 행 수. F9·F10 이 켜지면 보이는 행 수와 달라져 이 숫자가 유일한 단서가 된다(D1). */
	countEl: HTMLElement;
	handleEl: HTMLElement;
	groupId: string | null;
}

/** 잘린 그룹의 마지막 줄 — `Show all (N)`(F9) 또는 그룹 페이저(F10)가 여기 선다. */
interface PlusGroupFooter {
	el: HTMLElement;
	moreEl: HTMLElement;
	pager: PagerHandle;
	groupId: string | null;
}

interface ColumnResize {
	property: BasesPropertyId;
	index: number;
	pointerId: number;
	startX: number;
	startWidth: number;
	/** RTL 이면 오른쪽으로 끌 때 폭이 줄어야 한다. */
	direction: 1 | -1;
	/** 이 제스처가 확정값으로 굳힌 열들 — 끌지 않고 놓으면 되돌린다. */
	frozen: BasesPropertyId[];
	/** 실제로 폭이 움직였는지. 안 움직였으면 저장하지 않는다(더블클릭이 폭을 저장해 버리지 않게). */
	moved: boolean;
}

/**
 * 묶음 B(표·카드)의 진입점. 네이티브 표 뷰와 같은 형태(열 헤더 · 속성 열 · 셀 렌더 · 열 폭 조절)로 그리고,
 * 네이티브처럼 **파일 이름 링크**를 눌러 여는데 여는 방식은 뷰 옵션 `Open rows with` 를 따른다(묶음 A).
 *
 * 무엇을 어떤 순서로 그릴지는 이 클래스가 정하지 않는다 — `rowPlan.ts` 가 세운 계획을 요소 풀에 붙일 뿐이다.
 * 타임라인(2단계)의 왼쪽 판이 같은 계획을 그대로 먹는다.
 */
export class PlusTableView extends BasesView {
	type = PLUS_TABLE_VIEW_TYPE;

	protected readonly containerEl: HTMLElement;
	protected readonly rootEl: HTMLElement;
	private readonly noticeEl: HTMLElement;
	protected readonly tableEl: HTMLElement;
	protected readonly headEl: HTMLElement;
	/**
	 * 열 헤더 칸이 실제로 들어가는 자리. 표에서는 머리 줄 자신이지만 타임라인에서는 **왼쪽 위 빈칸의
	 * 바닥 줄**이다 — 축의 층들이 그 위에 함께 쌓여야 두 판의 머리가 한 줄에서 끝난다(타임라인 A3).
	 */
	protected headCellsEl: HTMLElement;
	protected readonly rowsEl: HTMLElement;
	/** 드래그 중에만 보이는 드롭 자리. 행·그룹·값 목록이 같은 표시자를 쓴다. */
	private readonly dropIndicatorEl: HTMLElement;
	protected readonly footerEl: HTMLElement;
	private readonly footerPager: PagerHandle;
	protected readonly errorEl: HTMLElement;
	private readonly headerCells: PlusHeaderCell[] = [];
	protected readonly rows: PlusRow[] = [];
	protected readonly headings: PlusGroupHeading[] = [];
	private readonly groupFooters: PlusGroupFooter[] = [];
	/** 편집 중인 셀 — 갱신이 와도 이 셀만은 다시 그리지 않는다(타이핑 중에 입력칸이 사라지지 않게). */
	private editing: PlusCell | null = null;
	/** 사용자가 정한 열 폭. `.base` 의 `columnSize` 와 같은 내용이며 네이티브 표와 같은 키다. */
	private widths: Map<BasesPropertyId, number>;
	private resize: ColumnResize | null = null;
	/** 보고 있는 페이지. **저장하지 않는다** — 보는 위치이지 뷰 설정이 아니다(B4). */
	private page = 1;
	private readonly groupPages = new Map<string, number>();
	/** `Show all` 로 이번에 펼쳐 둔 그룹. 저장하지 않는다 — 설정을 바꾸는 것이 아니다(D3). */
	private readonly expandedGroups = new Set<string>();
	/** 마지막으로 세운 계획. 드래그가 "같은 묶음"을 여기서 읽는다. */
	private plan: RowPlan | null = null;
	private readonly rowDrag: OrderDrag;
	private readonly groupDrag: OrderDrag;
	private footerMounted = false;

	constructor(
		controller: QueryController,
		containerEl: HTMLElement,
		private readonly host: PlusTableHost
	) {
		super(controller);

		// 설정 탭에서 기본 행 수를 바꾸면 이미 열려 있는 뷰도 따라와야 한다. 구독 해제는 Component 가 맡는다(관2·성5).
		this.register(
			host.onSettingsChanged(() => {
				// 아직 첫 데이터가 오기 전이면 그릴 것이 없다 — config 도 그때 붙는다(T27).
				if (this.data) this.onDataUpdated();
			})
		);

		this.containerEl = containerEl;
		this.rootEl = containerEl.createDiv({ cls: 'bases-plus-view' });
		// 안내 띠와 오류 줄은 달력과 **같은 것**을 쓴다 — 같은 성격의 줄이 뷰마다 다른 문구를 갖지 않게.
		this.noticeEl = createNoticeEl(this.rootEl);
		this.tableEl = this.rootEl.createDiv({ cls: 'bases-plus-table' });
		this.headEl = this.tableEl.createDiv({ cls: 'bases-plus-thead' });
		this.headCellsEl = this.headEl;
		this.rowsEl = this.tableEl.createDiv({ cls: 'bases-plus-rows' });
		this.dropIndicatorEl = this.rowsEl.createDiv({ cls: 'bases-plus-drop-indicator' });
		this.footerEl = this.rootEl.createDiv({ cls: 'bases-plus-footer' });
		this.footerPager = createPager(
			this.footerEl,
			{
				register: (el, type, handler) => this.registerDomEvent(el, type, handler),
				onGo: (page) => {
					this.page = page;
					this.onDataUpdated();
				},
			},
			'bases-plus-footer-bar'
		);
		// 페이지가 하나뿐이면 바 자체를 두지 않는다 — 빈 30px 띠를 남기지 않는다(B2).
		this.footerEl.detach();
		this.errorEl = createErrorEl(this.rootEl);

		this.rowDrag = new OrderDrag({
			containerEl: this.rowsEl,
			indicatorEl: this.dropIndicatorEl,
			slots: (path) => this.rowSlots(path),
			commit: (paths) => this.commitRowOrder(paths),
		});
		this.groupDrag = new OrderDrag({
			containerEl: this.rowsEl,
			indicatorEl: this.dropIndicatorEl,
			slots: () => this.groupSlots(),
			commit: (ids) => this.commitGroupOrder(ids),
		});

		// 여기서 `this.config` 를 읽으면 안 된다 — 컨트롤러는 팩토리가 **끝난 뒤에** `view.config` 를 붙인다
		// (1.13.4 app.js 오프셋 2500709: `this.view = a(this, ...)` 다음 줄이 `this.view.config = r`).
		// 생성자에서 건드리면 TypeError 가 나고, 탭에서는 빈 화면·임베드에서는 코드블록 오류 토스트가 된다.
		this.widths = new Map();
	}

	onunload(): void {
		// 리스너는 registerDomEvent 로 걸어 뒀으므로 Component 가 알아서 푼다(관2·성5).
		this.rowDrag.cancel();
		this.groupDrag.cancel();
		this.rootEl.remove();
		this.rows.length = 0;
		this.headerCells.length = 0;
		this.resize = null;
	}

	onDataUpdated(): void {
		// 네이티브 뷰 3종이 모두 여기서 is-loading 을 뗀다. 빠뜨리면 로딩 표시가 남는다.
		this.containerEl.removeClass('is-loading');

		try {
			this.render();
			this.errorEl.hide();
		} catch (error) {
			// 여기서 막지 않으면 원인이 화면에 남지 않는다 — 탭에서는 컨트롤러가 이 예외로 멈춰 표가 통째로 비고
			// (오프셋 2502560 의 notifyView 는 try/catch 가 없다), 임베드에서는 코어가 코드블록 오류 토스트만 띄운다.
			console.error('Bases Plus: rendering the table failed.', error);
			this.showError();
		}
	}

	private render(): void {
		const properties = this.getColumns();

		// 저장된 폭은 그릴 때마다 다시 읽는다 — 다른 창에서 같은 base 를 고쳤을 수 있다. 끄는 중에는 손대지 않는다.
		if (!this.resize) this.widths = readColumnWidths(this.config);

		const plan = this.buildPlan();
		this.plan = plan;
		this.page = plan.page;

		// 순서 모드는 표 전체를 같은 값만큼 민다 — 변수 하나로 잡아 축이 갈라지지 않게 한다(A3).
		// 여백 열은 행·그룹 중 **하나만 켜져도** 생긴다. 어느 손잡이를 그릴지는 아래 두 표식이 따로 정한다.
		this.rootEl.toggleClass('is-ordering', plan.ordering || plan.groupOrdering);
		this.rootEl.toggleClass('is-row-ordering', plan.ordering);
		this.rootEl.toggleClass('is-group-ordering', plan.groupOrdering);
		this.syncNotice(plan.notice);
		this.syncHeader(properties);
		this.syncGroups(plan, properties);
		// 폭을 안 정한 열은 내용에 맞춘다 — 행을 다 붙인 뒤라야 잰 값이 맞다. 끄는 중에는 건드리지 않는다.
		if (!this.resize) this.applyAutoWidths(properties);
		this.syncFooter(plan.pager);
		this.afterRender(plan, properties);
	}

	/**
	 * 계획을 다 붙인 뒤. 표는 여기서 할 일이 없고 **타임라인이 축·막대·오늘 틴트를 그린다** —
	 * 그때는 행 요소가 이미 제자리에 있어 좌표를 재도 맞다.
	 */
	protected afterRender(_plan: RowPlan, _properties: BasesPropertyId[]): void {}

	/**
	 * 행 하나를 붙인 직후. 타임라인이 **그 행의 연관 행을 바로 뒤에 끼워 넣는 자리**다 —
	 * 나중에 붙이면 부모와 떨어지고, `appendChild` 는 이미 붙은 요소를 맨 뒤로 옮기기 때문이다(F1).
	 */
	protected afterRowAppended(_row: PlusRow): void {}

	/** 계획 세우기 — 자르기·순서·페이지 계산은 전부 `rowPlan.ts` 가 한다. 여기서는 설정을 읽어 넘길 뿐이다. */
	protected buildPlan(): RowPlan {
		const entries = this.data?.data ?? [];
		const groups = this.sourceGroups();
		const limit = resolveRowLimit(this.config);
		const sort = this.readSort();
		const groupProperty = this.getGroupProperty();
		const sortProperty = sort.length > 0 ? sort[0].property : null;

		return buildRowPlan({
			entries,
			groups,
			limit,
			pageSize: resolvePageSize(this.config.get(PAGE_SIZE_KEY), this.host.getDefaultPageSize()),
			groupSize: resolvePageSize(this.config.get(GROUP_SIZE_KEY), this.host.getDefaultPageSize()),
			page: this.page,
			groupPages: this.groupPages,
			expandedGroups: this.expandedGroups,
			collapsedGroups: new Set(readStringList(this.config, COLLAPSED_GROUPS_KEY)),
			manualOrder: this.config.get(MANUAL_ORDER_ENABLED_KEY) === true,
			groupManualOrder: this.config.get(GROUP_ORDER_ENABLED_KEY) === true,
			sorted: sort.length > 0,
			rowOrder: readStringList(this.config, MANUAL_ORDER_KEY),
			groupOrder: readStringList(this.config, GROUP_ORDER_KEY),
			// 목록값 순서는 그 열이 **정렬 열일 때만** 행에 걸린다(F4).
			rowRank: this.valueRankFor(sortProperty),
			groupRank: this.groupRankFor(groupProperty),
			rankDescending: sort.length > 0 && sort[0].direction === 'DESC',
			groupDescending: this.getGroupDirection() === 'DESC',
		});
	}

	/**
	 * 그룹 기준이 걸려 있을 때만 그룹을 넘긴다. 그룹 기준이 없어도 컨트롤러는 키 없는 그룹 하나를 주므로
	 * (d.ts — "If there is no groupBy configured, returns a single group with an empty key")
	 * **키가 하나라도 있는지**로 가른다.
	 */
	private sourceGroups(): SourceGroup[] {
		const grouped = this.data?.groupedData ?? [];
		if (!grouped.some((group) => group.key != null)) return [];

		return grouped.map((group) => ({
			key: group.key ?? null,
			hasKey: hasGroupKey(group),
			entries: group.entries,
		}));
	}

	/** 정렬 설정. `getSort()` 는 d.ts 공개지만 런타임이 낮으면 없을 수 있어 능력으로 확인한다. */
	private readSort(): BasesSortConfig[] {
		try {
			const config = this.config as unknown as { getSort?: () => BasesSortConfig[] };
			const sort = typeof config.getSort === 'function' ? config.getSort() : null;

			return Array.isArray(sort) ? sort : [];
		} catch (error) {
			console.error('Bases Plus: could not read the sort config.', error);
			return [];
		}
	}

	/** 목록값 순서를 행 순위로 바꾼다. 그 열이 목록 타입이 아니거나 순서를 안 정했으면 null 이라 아무 일도 없다. */
	private valueRankFor(property: BasesPropertyId | null) {
		if (!isListProperty(this.app, property)) return null;

		const order = readValueOrder(this.config, property);
		if (order.length === 0) return null;

		const rank = new Map<string, number>();
		order.forEach((value, index) => {
			if (!rank.has(value)) rank.set(value, index);
		});

		return (entry: BasesEntry) => {
			const text = readEditableValue(entry, property);

			return { rank: rank.get(text) ?? null, text };
		};
	}

	private groupRankFor(property: BasesPropertyId | null) {
		if (!isListProperty(this.app, property)) return null;

		const order = readValueOrder(this.config, property);
		if (order.length === 0) return null;

		const rank = new Map<string, number>();
		order.forEach((value, index) => {
			if (!rank.has(value)) rank.set(value, index);
		});

		return (id: string) => rank.get(id) ?? null;
	}

	protected showError(): void {
		showViewError(this.errorEl);
	}

	/** 열은 컨트롤러가 준 표시 속성 순서 그대로다 — 네이티브 표도 같은 값을 쓴다(속성 툴바 메뉴 소유). */
	protected getColumns(): BasesPropertyId[] {
		const properties = this.data?.properties ?? [];

		return properties.length > 0 ? properties : [FILE_NAME_PROPERTY];
	}

	/** 뷰 옵션(툴바)에 저장된 열기 방식. 우리 뷰는 설정 탭 전역값이 아니라 이 값을 쓴다(D21). */
	protected getOpenMode(): OpenMode {
		return resolveOpenMode(this.config.get(OPEN_MODE_KEY));
	}

	/**
	 * 기능이 조건 때문에 지금 동작하지 않을 때만 나오는 한 줄(A4). 오류가 아니라 상태 설명이라
	 * `--text-error` 를 쓰지 않는다 — 사용자가 뭘 잘못한 것이 아니다.
	 */
	private syncNotice(notice: string | null): void {
		syncNoticeEl(this.noticeEl, notice);
	}

	private syncHeader(properties: BasesPropertyId[]): void {
		while (this.headerCells.length < properties.length) {
			this.headerCells.push(this.createHeaderCell());
		}

		for (let i = 0; i < this.headerCells.length; i++) {
			const header = this.headerCells[i];
			const property = properties[i] ?? null;

			// 속성을 숨기면 열이 줄어든다. 요소는 재사용을 위해 남기고 감추기만 한다(성2).
			if (!property) {
				header.el.hide();
				continue;
			}

			header.el.show();
			header.el.setAttr('data-property', property);
			// 사용자가 base 에서 이름을 바꿨으면 그 이름이 나온다.
			header.nameEl.setText(this.config.getDisplayName(property));
			// setIcon 은 같은 아이콘이면 아무것도 안 하고 다르면 갈아 끼운다 — 다시 그려도 svg 가 쌓이지 않는다.
			setIcon(header.iconEl, propertyTypeIcon(this.app, property));
			applyWidth(header.el, this.widths.get(property));
		}
	}

	/**
	 * 그룹 헤딩·행·그룹 푸터를 계획 순서대로 붙인다. 요소는 풀에서 재사용하고 남는 것은 감춘다 — 갱신마다
	 * 컨테이너를 비우고 다시 만드는 구현은 공식 성능 요구(성1·성2 — 수천 항목 감당·DOM 재사용) 위반이다.
	 * 이미 붙어 있는 요소를 다시 append 하면 그 자리로 옮겨진다 — 그래서 순서만 다시 잡으면 된다.
	 *
	 * **접힌 그룹의 행도 DOM 에서 지우지 않고 감춘다** — 요소 풀 재사용 구조를 깨지 않기 위해서다(D2).
	 */
	private syncGroups(plan: RowPlan, properties: BasesPropertyId[]): void {
		const propertyTypes = properties.map((property) => registeredPropertyType(this.app, property));
		let rowIndex = 0;
		let headingIndex = 0;
		let footerIndex = 0;

		for (const group of plan.groups) {
			if (group.id !== null) {
				const heading = this.getHeading(headingIndex);
				// `:first-child` 로 대신하면 안 된다 — 풀에서 남아 감춰진 헤딩·행이 앞쪽에 있을 수 있다.
				heading.el.toggleClass('is-first-group', headingIndex === 0);
				headingIndex++;
				this.renderGroupHeading(heading, group);
				this.rowsEl.appendChild(heading.el);
			}

			for (const entry of group.entries) {
				const row = this.getRow(rowIndex++);

				row.entry = entry;
				row.groupId = group.id;
				if (group.collapsed) row.el.hide();
				else row.el.show();
				this.syncCells(row, entry, properties, propertyTypes);
				this.rowsEl.appendChild(row.el);
				this.afterRowAppended(row);
			}

			if (group.truncated || group.pager) {
				const footer = this.getGroupFooter(footerIndex++);
				this.renderGroupFooter(footer, group);
				this.rowsEl.appendChild(footer.el);
			}
		}

		for (let i = rowIndex; i < this.rows.length; i++) {
			this.rows[i].entry = null;
			this.rows[i].groupId = null;
			this.rows[i].el.hide();
		}

		for (let i = headingIndex; i < this.headings.length; i++) {
			this.headings[i].groupId = null;
			this.headings[i].el.hide();
		}

		for (let i = footerIndex; i < this.groupFooters.length; i++) {
			this.groupFooters[i].groupId = null;
			this.groupFooters[i].el.hide();
		}
	}

	private getRow(index: number): PlusRow {
		while (this.rows.length <= index) this.rows.push(this.createRow());

		return this.rows[index];
	}

	private getHeading(index: number): PlusGroupHeading {
		while (this.headings.length <= index) this.headings.push(this.createHeading());

		this.headings[index].el.show();

		return this.headings[index];
	}

	private getGroupFooter(index: number): PlusGroupFooter {
		while (this.groupFooters.length <= index) this.groupFooters.push(this.createGroupFooter());

		this.groupFooters[index].el.show();

		return this.groupFooters[index];
	}

	/** 네이티브와 같은 "속성명 값" 형태에 접기 화살표·개수·손잡이가 앞뒤로 붙는다(D1). */
	private renderGroupHeading(heading: PlusGroupHeading, group: PlanGroup): void {
		const propertyName = this.getGroupPropertyName();

		heading.groupId = group.id;

		if (propertyName === null) {
			heading.propertyEl.hide();
		} else {
			heading.propertyEl.show();
			heading.propertyEl.setText(propertyName);
		}

		heading.valueEl.empty();

		// 그룹 기준 값이 비어 있는 묶음 — 네이티브도 이 자리에 "없음" 문구를 넣는다.
		if (!group.key || !group.hasKey) heading.valueEl.setText(noValueLabel());
		else group.key.renderTo(heading.valueEl, this.app.renderContext);

		heading.countEl.setText(String(group.total));
		heading.el.addClass('is-collapsible');
		heading.el.toggleClass('is-collapsed', group.collapsed);
		heading.el.setAttr('aria-expanded', group.collapsed ? 'false' : 'true');
	}

	/** `Show all (N)`(F9)과 그룹 페이저(F10)는 같은 자리를 쓴다 — 한 번에 하나만 보인다. */
	private renderGroupFooter(footer: PlusGroupFooter, group: PlanGroup): void {
		footer.groupId = group.id;
		// 접힌 그룹은 페이저·펼치기 버튼도 함께 감춘다(D4).
		if (group.collapsed) footer.el.hide();

		if (group.truncated) {
			footer.el.removeClass('is-paged');
			footer.moreEl.show();
			// 괄호 안은 **그 그룹의 전체 행 수**다. 네이티브 `buttonShowAllCount` 를 빌린 우리 컨트롤 이름이라 영어다.
			footer.moreEl.setText(t('Show all ({{count}})', { count: group.total }));
			footer.pager.update(null);
			return;
		}

		footer.el.addClass('is-paged');
		footer.moreEl.hide();
		footer.pager.update(group.pager);
	}

	/**
	 * 그룹 기준 속성의 표시 이름. `BasesViewConfig.groupBy` 는 d.ts 공개 멤버가 아니라 캐스팅으로 읽는다 —
	 * **읽기 전용 1지점**이고(D1 채택), 못 읽으면 속성명을 생략할 뿐 값은 그대로 그려진다.
	 * 이름을 얻은 뒤 `getDisplayName()` 은 공개 API 다.
	 */
	private getGroupPropertyName(): string | null {
		const property = this.getGroupProperty();

		return property === null ? null : this.config.getDisplayName(property);
	}

	protected getGroupProperty(): BasesPropertyId | null {
		const property = this.readGroupBy()?.property;

		return typeof property === 'string' ? (property as BasesPropertyId) : null;
	}

	/** 툴바 `Group by` 의 오름·내림. 못 읽으면 오름차순으로 본다(네이티브 기본값과 같다). */
	private getGroupDirection(): string | null {
		const direction = this.readGroupBy()?.direction;

		return typeof direction === 'string' ? direction : null;
	}

	/**
	 * `BasesViewConfig.groupBy` 는 d.ts 공개 멤버가 아니라 캐스팅으로 읽는다 — **읽기 전용 1지점**이다(D1 채택).
	 * 속성과 방향 둘 다 같은 객체에서 나오므로 접근 지점이 늘지 않는다.
	 */
	private readGroupBy(): { property?: unknown; direction?: unknown } | undefined {
		return (this.config as unknown as { groupBy?: { property?: unknown; direction?: unknown } })?.groupBy;
	}

	private syncCells(
		row: PlusRow,
		entry: BasesEntry,
		properties: BasesPropertyId[],
		propertyTypes: (string | null)[]
	): void {
		if (row.cells.length < properties.length) {
			while (row.cells.length < properties.length) row.cells.push(this.createCell(row));
			// 손잡이는 늘 셀들 뒤에 있어야 한다 — 앞에 두면 본문 첫 열만 `:first-child` 두 배 규칙을 잃는다(C2 함정).
			row.el.appendChild(row.handleEl);
		}

		for (let i = 0; i < row.cells.length; i++) {
			const cell = row.cells[i];
			const property = properties[i] ?? null;

			// 편집 중인 칸은 건드리지 않는다 — 타이핑 도중 갱신이 오면 입력칸이 사라진다.
			if (this.editing === cell) continue;

			cell.property = property;

			if (!property) {
				cell.el.hide();
				continue;
			}

			cell.el.show();
			cell.el.setAttr('data-property', property);
			// 정렬은 **등록된 속성 타입**이 잡는다 — 그래야 값이 빈 숫자 칸도 우측에 선다(E5).
			cell.el.setAttr('data-property-type', propertyTypes[i]);
			cell.valueEl.empty();
			cell.valueType = this.renderCell(cell, entry, property);
			cell.el.setAttr('data-value-type', cell.valueType);
			cell.el.toggleClass('is-editable', isEditableProperty(property) && isEditableValueType(cell.valueType));
			// 글자를 치는 칸에만 텍스트 커서를 준다 — 체크박스·날짜는 누르거나 고르는 칸이다.
			cell.el.toggleClass('is-typing', isTypingProperty(this.app, property, cell.valueType));
			applyWidth(cell.el, this.widths.get(property));
		}
	}

	/** @returns 그린 값의 타입 이름. 셀이 비면 null 이라 정렬용 속성이 붙지 않는다. */
	private renderCell(cell: PlusCell, entry: BasesEntry, property: BasesPropertyId): string | null {
		// file.file 의 renderTo 가 네이티브 파일 링크(hover 미리보기·우클릭 메뉴 포함)를 공개 API 만으로 낸다.
		const source = property === FILE_NAME_PROPERTY ? FILE_LINK_PROPERTY : property;

		// 목록·태그는 값이 있든 없든 **표시 상태부터** 알약이다 — 편집 모드가 따로 없다(7차 1번).
		if (source === property && isChipProperty(this.app, property, valueTypeOf(entry, property))) {
			renderChipCell({
				app: this.app,
				file: entry.file,
				property,
				entry,
				el: cell.valueEl,
				current: readEditableValue(entry, property),
				// 입력칸에 포커스가 있는 동안에는 이 칸을 다시 그리지 않는다 — 치던 글자가 사라지지 않게.
				onFocusChange: (focused) => {
					if (focused) this.editing = cell;
					else if (this.editing === cell) this.editing = null;
				},
			});

			return 'list';
		}

		const type = renderValue(this.app, entry, source, cell.valueEl);

		if (type === null && source === FILE_LINK_PROPERTY) cell.valueEl.setText(entry.file.basename);
		// 빈 날짜 칸은 값이 없어 아무것도 안 그려진다 — 네이티브처럼 흐린 플레이스홀더를 세운다(8차 2번).
		else if (source === property) renderEmptyDatePlaceholder(this.app, property, type, cell.valueEl);

		return type;
	}

	private createHeaderCell(): PlusHeaderCell {
		const el = this.headCellsEl.createDiv({ cls: 'bases-plus-th' });
		const labelEl = el.createDiv({ cls: 'bases-plus-th-label' });
		// 네이티브 헤더 라벨도 아이콘·이름 두 조각이다(app.js 헤더 셀 생성 — `bases-table-header-icon`/`-name`).
		const iconEl = labelEl.createDiv({ cls: 'bases-plus-th-icon' });
		const nameEl = labelEl.createDiv({ cls: 'bases-plus-th-name' });
		const resizerEl = el.createDiv({ cls: 'bases-plus-th-resizer' });
		const header: PlusHeaderCell = { el, labelEl, iconEl, nameEl, resizerEl };

		// 포인터 캡처를 잡으면 이후 이동·놓기 이벤트가 손잡이로 직접 온다 — 창(document)에 리스너를 붙일 일이 없고
		// 팝아웃 창에서도 그대로 동작한다. 마우스·터치·펜이 같은 경로다.
		this.registerDomEvent(resizerEl, 'pointerdown', (evt) => this.onResizeStart(header, evt));
		this.registerDomEvent(resizerEl, 'pointermove', (evt) => this.onResizeMove(evt));
		this.registerDomEvent(resizerEl, 'pointerup', (evt) => this.onResizeEnd(evt));
		this.registerDomEvent(resizerEl, 'pointercancel', (evt) => this.onResizeEnd(evt));
			// 경계 더블클릭 = 그 열 폭 되돌리기. 네이티브도 같은 자리에 같은 동작을 건다
		// (1.13.4 app.js 오프셋 3112287 `onTableHeaderResizerDblclick` → `resetColumnSize`).
		this.registerDomEvent(resizerEl, 'dblclick', (evt) => this.onResizerDoubleClick(header, evt));
		// 목록 타입 열에만 메뉴가 뜬다. 다른 열은 항목이 없어 메뉴 자체를 만들지 않는다(F2).
		this.registerDomEvent(el, 'contextmenu', (evt) => this.onHeaderContextMenu(header, evt));

		return header;
	}

	protected createRow(): PlusRow {
		const el = this.rowsEl.createDiv({ cls: 'bases-plus-row' });
		// 셀 상자는 하위 클래스가 갈아 끼운다 — 타임라인은 `sticky` 왼쪽 판을 한 겹 씌운다(A2).
		const cellsEl = this.createRowCellsEl(el);
		const handleEl = this.createOrderHandle(el, 'Reorder row');
		const row: PlusRow = { el, cellsEl, cells: [], entry: null, handleEl, groupId: null };

		// 리스너는 행 요소를 만들 때 한 번만 건다. 갱신마다 걸면 등록이 누적된다.
		this.registerDomEvent(el, 'contextmenu', (evt) => {
			// 파일 링크 위 우클릭은 코어가 링크 메뉴를 띄우며 preventDefault 를 건다 — 그 위에 겹쳐 열지 않는다.
			if (evt.defaultPrevented || !row.entry) return;

			evt.preventDefault();
			const menu = new Menu();
			addOpenItem(menu, this.app, row.entry.file, this.getOpenMode());
			menu.showAtMouseEvent(evt);
		});

		this.bindOrderHandle(
			handleEl,
			this.rowDrag,
			() => row.entry?.file?.path ?? null,
			(path) => focusHandle(this.rows.find((item) => item.entry?.file?.path === path)?.handleEl)
		);

		return row;
	}

	/** 표에서는 셀이 행 요소의 직속 자식이다 — 감싸는 상자가 없어야 `:first-child` 규칙이 첫 열을 잡는다. */
	protected createRowCellsEl(rowEl: HTMLElement): HTMLElement {
		return rowEl;
	}

	protected createHeading(): PlusGroupHeading {
		// 네이티브 헤딩도 속성명·값 두 조각이다(app.js `createGroupHeadingEl`). 앞뒤로 자식만 늘어난다.
		const el = this.rowsEl.createDiv({ cls: 'bases-plus-group-heading' });
		const toggleEl = el.createDiv({ cls: 'bases-plus-group-toggle' });
		// 코어가 파일탐색기·검색결과·속성 헤딩·접은 문단에 전부 쓰는 그 하나다.
		setIcon(toggleEl, 'right-triangle');

		const heading: PlusGroupHeading = {
			el,
			toggleEl,
			propertyEl: el.createDiv({ cls: 'bases-plus-group-property' }),
			valueEl: el.createDiv({ cls: 'bases-plus-group-value' }),
			countEl: el.createDiv({ cls: 'bases-plus-group-count' }),
			// 손잡이는 행과 같은 순서로 **맨 뒤에** 만든다(C2 함정).
			handleEl: this.createOrderHandle(el, 'Reorder group'),
			groupId: null,
		};

		el.setAttr('role', 'button');
		el.setAttr('tabindex', '0');

		this.registerDomEvent(el, 'click', (evt) => {
			// 손잡이 위 클릭은 드래그 시작이지 접기가 아니다(D2).
			if (isInside(evt.target, HANDLE_SELECTOR)) return;

			this.toggleGroup(heading.groupId);
		});
		this.registerDomEvent(el, 'keydown', (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;

			evt.preventDefault();
			this.toggleGroup(heading.groupId);
		});
		this.bindOrderHandle(
			heading.handleEl,
			this.groupDrag,
			() => heading.groupId,
			(id) => focusHandle(this.headings.find((item) => item.groupId === id)?.handleEl)
		);

		return heading;
	}

	private createGroupFooter(): PlusGroupFooter {
		const el = this.rowsEl.createDiv({ cls: 'bases-plus-group-footer' });
		const footer: PlusGroupFooter = {
			el,
			moreEl: el.createEl('button', { cls: 'bases-plus-group-more', attr: { type: 'button' } }),
			pager: createPager(
				el,
				{
					register: (target, type, handler) => this.registerDomEvent(target, type, handler),
					onGo: (page) => {
						if (footer.groupId !== null) this.groupPages.set(footer.groupId, page);
						this.onDataUpdated();
					},
				},
				'bases-plus-group-pager'
			),
			groupId: null,
		};

		this.registerDomEvent(footer.moreEl, 'click', () => {
			if (footer.groupId === null) return;

			// 펼침은 저장하지 않는다 — 이번에 더 보려는 것이지 설정을 바꾸는 것이 아니다(D3).
			this.expandedGroups.add(footer.groupId);
			this.onDataUpdated();
		});

		return footer;
	}

	/** 손잡이는 절대 배치라 DOM 어디에 있든 같은 자리에 그려진다 — 그래서 내용 뒤에 붙일 수 있다(C2). */
	private createOrderHandle(parentEl: HTMLElement, label: string): HTMLElement {
		const el = parentEl.createDiv({ cls: 'bases-plus-order-handle' });
		// 코어가 마크다운 표의 행 드래그에 쓰는 바로 그 글리프다(app.js 오프셋 2032173 에서 이름을 조립한다).
		setIcon(el, 'lucide-grip-vertical');
		el.setAttr('role', 'button');
		el.setAttr('tabindex', '0');
		el.setAttr('aria-label', label);

		return el;
	}

	/**
	 * @param refocus 옮긴 뒤 그 항목의 손잡이를 다시 찾아 포커스를 준다. 키보드 이동은 `commit` 이
	 *   곧바로 다시 그리는데, 요소 풀은 **자리 기준**이라 같은 요소가 다른 행을 맡게 된다 —
	 *   그대로 두면 포커스가 풀리거나 다음 화살표가 엉뚱한 행을 옮긴다(마스터 15번 "됐다 풀리는 느낌").
	 */
	private bindOrderHandle(
		el: HTMLElement,
		drag: OrderDrag,
		idOf: () => string | null,
		refocus: (id: string) => void
	): void {
		this.registerDomEvent(el, 'pointerdown', (evt) => {
			const id = idOf();
			if (id !== null) drag.start(id, el, evt);
		});
		this.registerDomEvent(el, 'pointermove', (evt) => drag.move(evt));
		this.registerDomEvent(el, 'pointerup', (evt) => drag.end(evt));
		this.registerDomEvent(el, 'pointercancel', () => drag.cancel());
		// 손잡이에 포커스를 두고 화살표 키로도 옮긴다. 포커스는 손잡이에 남는다(C3).
		this.registerDomEvent(el, 'keydown', (evt) => {
			const delta = evt.key === 'ArrowUp' ? -1 : evt.key === 'ArrowDown' ? 1 : 0;
			const id = idOf();
			if (delta === 0 || id === null) return;

			evt.preventDefault();
			if (drag.nudge(id, delta)) refocus(id);
		});
		// 손잡이 클릭이 행 열기·그룹 접기로 새지 않게 한다.
		this.registerDomEvent(el, 'click', (evt) => evt.stopPropagation());
	}

	/** 드래그는 **자기 그룹·자기 페이지 안에서만** 이다 — 밖으로는 드롭 표시자가 서지 않는다(C4). */
	private rowSlots(path: string): OrderSlot[] {
		const owner = this.rows.find((row) => row.entry?.file?.path === path);
		if (!owner) return [];

		return this.rows
			.filter((row) => row.entry !== null && row.groupId === owner.groupId)
			.map((row) => ({ el: row.el, id: row.entry?.file?.path ?? '' }));
	}

	private groupSlots(): OrderSlot[] {
		return this.headings
			.filter((heading) => heading.groupId !== null)
			.map((heading) => ({ el: heading.el, id: heading.groupId ?? '' }));
	}

	/**
	 * 전체 순서 안에서 이번에 옮긴 자리들만 갈아 끼운다 — 페이지·그룹 밖 행의 상대 위치는 그대로 남는다(C4).
	 * 저장은 **놓을 때 한 번**이다. 지금 쿼리 결과에 없는 경로는 버린다(열 폭 저장과 같은 규칙).
	 */
	private commitRowOrder(paths: string[]): void {
		const full = this.plan?.order.slice() ?? [];
		const slots: number[] = [];

		for (let i = 0; i < full.length; i++) {
			if (paths.indexOf(full[i]) !== -1) slots.push(i);
		}

		slots.forEach((at, index) => {
			full[at] = paths[index];
		});

		this.config.set(MANUAL_ORDER_KEY, full.length > 0 ? full : null);
		this.onDataUpdated();
	}

	private commitGroupOrder(ids: string[]): void {
		this.config.set(GROUP_ORDER_KEY, ids.length > 0 ? ids : null);
		this.onDataUpdated();
	}

	/** 접힘은 `.base` 에 저장한다(확정 4) — 다시 열어도 접힌 채다. 쓰기는 클릭당 한 번이라 열 폭과 같은 급이다. */
	private toggleGroup(id: string | null): void {
		if (id === null) return;

		const collapsed = readStringList(this.config, COLLAPSED_GROUPS_KEY);
		const at = collapsed.indexOf(id);

		if (at === -1) collapsed.push(id);
		else collapsed.splice(at, 1);

		this.config.set(COLLAPSED_GROUPS_KEY, collapsed.length > 0 ? collapsed : null);
		this.onDataUpdated();
	}

	/**
	 * 열 헤더 우클릭 — **목록 타입 열에만** 메뉴가 뜬다(F2). 다른 열에는 항목이 없어 메뉴 자체를 만들지 않는다.
	 * 흐리게 남겨 두면 "왜 안 되지"를 묻게 만든다.
	 */
	private onHeaderContextMenu(header: PlusHeaderCell, evt: MouseEvent): void {
		const property = header.el.getAttr('data-property') as BasesPropertyId | null;
		if (evt.defaultPrevented || !isListProperty(this.app, property)) return;

		evt.preventDefault();

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setSection('action')
				// 네이티브 열 헤더 메뉴가 대화상자를 여는 항목에 말줄임표를 붙인다(`Edit property...`).
				.setTitle(t('Set value order...'))
				.setIcon('lucide-list-ordered')
				.onClick(() => this.openValueOrder(property))
		);
		menu.showAtMouseEvent(evt);
	}

	private openValueOrder(property: BasesPropertyId): void {
		openValueOrderModal({
			app: this.app,
			title: this.config.getDisplayName(property),
			values: collectValues(this.data?.data ?? [], property, readValueOrder(this.config, property)),
			onOrder: (order) => {
				// 놓는 순간 저장한다 — 확인 버튼이 없는 것이 이 플러그인의 계약이다(F3).
				saveValueOrder(this.config, property, order);
				this.onDataUpdated();
			},
		});
	}

	/**
	 * 셀 클릭 갈래는 셋이다 — 이름 열의 파일 링크는 열기(네이티브와 같은 진입점), 프론트매터 열은 바로 편집,
	 * 그 밖(파일·수식 열, 다른 열의 링크)은 건드리지 않는다.
	 */
	private onCellClick(row: PlusRow, cell: PlusCell, evt: MouseEvent): void {
		if (!row.entry) return;
		// 수식어·보조 버튼 클릭은 코어 링크 동작(Cmd 클릭 = 새 탭 등)에 그대로 넘긴다.
		if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

		if (cell.property === FILE_NAME_PROPERTY) {
			if (!isInsideLink(evt.target)) return;

			evt.preventDefault();
			evt.stopPropagation();
			// 열기 방식은 클릭 시점에 다시 읽는다 — 뷰 옵션을 바꾸면 다음 클릭부터 바로 반영된다.
			void openTarget(this.app, row.entry.file, this.getOpenMode());
			return;
		}

		// 값 안의 링크(태그·내부 링크)는 그 목적지로 가야 한다 — 편집으로 가로채지 않는다.
		if (isInsideLink(evt.target)) return;
		if (this.editing === cell || !isEditableProperty(cell.property)) return;
		if (!isEditableValueType(cell.valueType)) return;
		// 알약 셀은 늘 편집 상태다 — 모드 전환이 없으니 여기서 편집기를 띄우지 않는다(알약 쪽이 클릭을 받는다).
		if (isChipProperty(this.app, cell.property, cell.valueType)) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.beginEdit(row, cell, cell.property);
	}

	private beginEdit(row: PlusRow, cell: PlusCell, property: BasesPropertyId): void {
		const entry = row.entry;
		if (!entry) return;

		// 화면 글자가 아니라 값 객체에서 읽는다 — 날짜·체크박스는 입력 요소로 그려져 화면 텍스트가 비어 있다.
		const current = readEditableValue(entry, property);
		const kind = resolveEditableKind(this.app, property, cell.valueType, current);

		// 체크박스는 입력칸 없이 그 자리에서 뒤집는다 — 네이티브도 체크박스만은 바로 눌러 바꾼다.
		if (kind === 'checkbox') {
			void toggleCheckbox(this.app, entry.file, property, current === 'true');
			return;
		}

		// 목록은 편집 모드가 없다 — 셀이 늘 알약이라 여기까지 오지 않는다(onCellClick 이 먼저 걸러낸다).
		if (kind === 'list') return;

		cell.el.addClass('is-editing');
		cell.valueEl.empty();
		this.editing = cell;

		beginCellEdit({
			app: this.app,
			file: entry.file,
			property,
			kind,
			el: cell.valueEl,
			current,
			entry,
			onDone: () => {
				this.editing = null;
				cell.el.removeClass('is-editing');
				// 저장했으면 볼트 변경으로 갱신이 오지만, 취소했을 때도 원래 값을 되살려야 한다.
				this.onDataUpdated();
			},
		});
	}

	private createCell(row: PlusRow): PlusCell {
		const el = row.cellsEl.createDiv({ cls: 'bases-plus-cell' });
		const valueEl = el.createDiv({ cls: 'bases-plus-value bases-rendered-value' });
		const cell: PlusCell = { el, valueEl, property: null, valueType: null };

		// 코어가 링크에 직접 건 리스너는 defaultPrevented 를 보지 않고 현재 탭에 파일을 연다(renderFileLink).
		// 캡처 단계에서 먼저 끊어야 한 번 클릭에 두 번 열리지 않는다.
		this.registerDomEvent(el, 'click', (evt) => this.onCellClick(row, cell, evt), {
			capture: true,
		});

		return cell;
	}

	/**
	 * 열 경계 더블클릭 — 그 열의 폭을 되돌린다(헤더 메뉴의 "Reset column width" 와 같은 동작).
	 * 네이티브도 주 버튼일 때만 반응한다.
	 *
	 * 이 제스처는 pointerdown·up 을 두 번 태우고 지나간다 — 그 두 번이 폭을 굳혀 저장해 버리면 되돌리려던
	 * 순간에 오히려 폭이 박힌다. 그래서 `onResizeEnd` 가 **끌지 않은 제스처는 굳히기를 되돌리고 저장도 하지
	 * 않는다**. 여기서는 폭만 다시 정하면 된다.
	 *
	 * 되돌린다 = **`columnSize` 에서 그 열 키를 지운다**(마스터 8차 4번). 잰 값을 설정으로 다시 박아 넣지
	 * 않는다 — 네이티브도 같은 방식이다: `resetColumnSize` 가 `customWidth = 0` 으로 두고,
	 * `saveColumnSizes` 가 `customWidth &&` 로 걸러 **키를 아예 안 쓴다**(1.13.4 app.js 오프셋 3139304).
	 * 설정이 없는 열은 아래 `applyAutoWidths()` 가 내용에 맞춰 준다.
	 */
	private onResizerDoubleClick(header: PlusHeaderCell, evt: MouseEvent): void {
		const property = header.el.getAttr('data-property') as BasesPropertyId | null;
		if (evt.button !== 0 || !property) return;

		evt.preventDefault();
		evt.stopPropagation();

		this.widths.delete(property);
		this.commitWidths();
	}

	/**
	 * 사용자가 폭을 정하지 않은 열을 **내용이 다 보이는 폭**으로 세운다(마스터 8차 4번 — "설정값이 제거되면서
	 * 내용들이 다 보이는 형태").
	 *
	 * 균등 배분(`flex: 1 1 0`)만으로는 긴 값이 잘린다. 그렇다고 `flex-basis: auto` 로 두면 헤더와 본문이
	 * **각자의 내용**을 기준으로 잡아 열이 어긋난다(디자인 문서가 344 대 353 으로 실측한 그 함정).
	 * 그래서 열마다 한 번 재서 **헤더·본문에 같은 px 을 준다** — 기준이 하나라 어긋나지 않는다.
	 *
	 * `flex-grow: 1` 은 남는 자리를 나눠 갖게 하고 `flex-shrink: 0` 은 내용 아래로 줄지 않게 한다.
	 * 잰 폭은 화면에만 쓰고 `.base` 에는 쓰지 않는다 — 사용자가 정한 값과 섞이면 안 된다.
	 */
	private applyAutoWidths(properties: BasesPropertyId[]): void {
		for (let i = 0; i < properties.length; i++) {
			if (this.widths.has(properties[i])) continue;

			const width = this.measureContentWidth(i);
			applyAutoWidth(this.headerCells[i]?.el, width);
			for (const row of this.rows) applyAutoWidth(row.cells[i]?.el, width);
		}
	}

	/**
	 * 그 열의 내용이 다 보이는 폭. 잘려 있어도 안쪽 요소의 `scrollWidth` 는 원래 내용 폭을 알고 있어서
	 * (말줄임은 `overflow:hidden` 이 만든 것뿐이다) 따로 재는 판을 만들지 않아도 된다.
	 * 상·하한은 네이티브와 같은 토큰 기준이다 — 한 열이 화면을 다 먹지 않게 막는다.
	 */
	private measureContentWidth(index: number): number {
		const candidates = [this.headerCells[index]?.labelEl];
		for (const row of this.rows) {
			if (row.entry) candidates.push(row.cells[index]?.valueEl);
		}

		let widest = 0;
		for (const el of candidates) {
			widest = Math.max(widest, measureContent(el));
		}

		return Math.min(MAX_AUTO_FIT_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest)));
	}

	private onResizeStart(header: PlusHeaderCell, evt: PointerEvent): void {
		const properties = this.getColumns();
		const index = this.headerCells.indexOf(header);
		const property = properties[index] ?? null;

		if (evt.button !== 0 || !property) return;

		evt.preventDefault();

		// 끄는 순간 모든 열의 현재 폭을 확정값으로 굳힌다. 안 그러면 한 열을 넓힐 때 나머지가 같이 줄어드는데,
		// 네이티브는 끄는 열만 바뀌고 표가 넓어진다 — 굳혀 두면 그다음부터 네이티브와 같이 움직인다.
		const frozen = this.freezeColumnWidths(properties);
		this.applyWidths(properties);

		this.resize = {
			property,
			index,
			pointerId: evt.pointerId,
			startX: evt.clientX,
			startWidth: this.widths.get(property) ?? MIN_COLUMN_WIDTH,
			direction: isRightToLeft(header.el) ? -1 : 1,
			frozen,
			moved: false,
		};

		header.resizerEl.addClass('is-active');
		capturePointer(header.resizerEl, evt.pointerId);
	}

	private onResizeMove(evt: PointerEvent): void {
		const resize = this.resize;
		if (!resize || resize.pointerId !== evt.pointerId) return;

		evt.preventDefault();

		const delta = (evt.clientX - resize.startX) * resize.direction;
		const width = Math.max(MIN_COLUMN_WIDTH, Math.round(resize.startWidth + delta));

		if (this.widths.get(resize.property) === width) return;

		resize.moved = true;
		this.widths.set(resize.property, width);
		this.applyColumnWidth(resize.index, width);
	}

	private onResizeEnd(evt: PointerEvent): void {
		const resize = this.resize;
		if (!resize || resize.pointerId !== evt.pointerId) return;

		const header = this.headerCells[resize.index];
		header?.resizerEl.removeClass('is-active');
		releasePointer(header?.resizerEl, evt.pointerId);
		this.resize = null;

		if (!resize.moved) {
			// 누르기만 하고 놓았다 — 굳히기를 되돌리고 저장도 하지 않는다. 이 자리가 폭 되돌리기 더블클릭
			// 자리이기도 해서, 여기서 저장하면 되돌리려던 순간에 오히려 폭이 `.base` 에 박힌다.
			for (const property of resize.frozen) this.widths.delete(property);
			this.applyWidths(this.getColumns());
			return;
		}

		// 끄는 동안이 아니라 놓을 때 한 번만 저장한다 — 매 프레임 저장하면 `.base` 파일을 그만큼 다시 쓴다.
		this.commitWidths();
	}

	/**
	 * 유동 폭으로 서 있던 열들을 지금 화면에 보이는 폭 그대로 확정값으로 바꾼다.
	 * @returns 이번에 굳힌 열들 — 끌지 않고 놓았을 때 되돌릴 대상이다.
	 */
	private freezeColumnWidths(properties: BasesPropertyId[]): BasesPropertyId[] {
		const frozen: BasesPropertyId[] = [];

		for (let i = 0; i < properties.length; i++) {
			const property = properties[i];
			if (this.widths.has(property)) continue;

			this.widths.set(property, Math.max(MIN_COLUMN_WIDTH, measureWidth(this.headerCells[i]?.el)));
			frozen.push(property);
		}

		return frozen;
	}

	/** 끄는 동안에는 바뀐 열 하나만 다시 칠한다 — 표 전체를 다시 그리면 프레임이 무너진다. */
	private applyColumnWidth(index: number, width: number | undefined): void {
		applyWidth(this.headerCells[index]?.el, width);

		for (const row of this.rows) {
			applyWidth(row.cells[index]?.el, width);
		}
	}

	/** 전 열의 폭을 화면에 반영한다. 폭을 되돌렸을 때 내용 맞춤으로 돌아가는 경로이기도 하다. */
	private applyWidths(properties: BasesPropertyId[]): void {
		for (let i = 0; i < properties.length; i++) {
			this.applyColumnWidth(i, this.widths.get(properties[i]));
		}

		// 방금 폭을 지운 열은 유동으로 돌아간 상태다 — 곧바로 내용 맞춤 폭을 다시 얹는다.
		this.applyAutoWidths(properties);
	}

	private commitWidths(): void {
		const properties = this.getColumns();

		// 지금 없는 열의 폭은 버린다 — 네이티브도 현재 표시 속성만 저장한다(app.js `saveColumnSizes`).
		this.widths.forEach((_width, property) => {
			if (properties.indexOf(property) === -1) this.widths.delete(property);
		});

		saveColumnWidths(this.config, this.widths);
		this.applyWidths(properties);
	}

	/**
	 * 페이저 바는 넘길 것이 있을 때만 선다. 없으면 요소를 아예 떼어 **빈 30px 띠를 남기지 않는다**(B2).
	 * 오류 줄은 늘 맨 아래에 있어야 해서 함께 다시 붙인다.
	 */
	protected syncFooter(pager: PagerState | null): void {
		this.footerPager.update(pager);

		const needed = pager !== null;
		if (needed === this.footerMounted) return;

		this.footerMounted = needed;
		if (!needed) {
			this.footerEl.detach();
			return;
		}

		this.rootEl.appendChild(this.footerEl);
		this.rootEl.appendChild(this.errorEl);
	}
}

/** 확정 폭이면 그 폭으로 고정하고, 없으면 클래스가 주는 유동 배분으로 되돌린다. */
function applyWidth(el: HTMLElement | undefined, width: number | undefined): void {
	if (!el) return;

	el.setCssStyles({ flex: typeof width === 'number' ? `0 0 ${width}px` : '' });
}

/**
 * 사용자가 정하지 않은 열의 자동 폭. 내용 폭을 기준으로 삼되(`flex-basis`) 남는 자리는 나눠 갖고
 * (`flex-grow: 1`) 내용 아래로는 줄지 않는다(`flex-shrink: 0`) — 그래서 값이 잘리지 않는다.
 */
function applyAutoWidth(el: HTMLElement | undefined, width: number): void {
	if (!el) return;

	el.setCssStyles({ flex: `1 0 ${width}px` });
}

/**
 * 그룹 기준 값이 비었을 때의 문구. **우리 문구가 아니라 네이티브 출력의 재현**이라 화면 언어를 따라간다(D3-B).
 * 네이티브 키는 `labelGroupKeyNone` = `None`(ko `없음`)이다 — 우리가 쓰던 `No value` 는 네이티브에 없는 말이었다.
 * 화면 언어는 공개 `getLanguage()` 한 곳에서만 읽는다(`shared/i18n` — 코어가 쓰는 값과 같다).
 * 우리 컨트롤 이름(New tab 등)은 영어 그대로 둔다 — 플러그인 안에서 언어가 섞이지 않게.
 */
function noValueLabel(): string {
	return appLanguage() === 'ko' ? '없음' : 'None';
}

/**
 * 그룹 기준 값이 실제로 있는지. `BasesEntryGroup.hasKey()` 는 d.ts 공개 멤버지만 없을 수도 있어 능력으로 확인한다.
 * 못 물어보면 값이 있는 것으로 보고 그대로 그린다.
 */
function hasGroupKey(group: BasesEntryGroup): boolean {
	const candidate = group as unknown as { hasKey?: unknown };

	return typeof candidate.hasKey === 'function' ? !!(candidate.hasKey as () => boolean)() : true;
}

/** 팝아웃 창은 realm 이 달라 `instanceof` 가 거짓이 된다 — 능력으로 판별한다(attachFileMenu 와 같은 이유). */
function isInside(target: EventTarget | null, selector: string): boolean {
	const candidate = target as { closest?(selector: string): unknown } | null;

	return !!candidate && typeof candidate.closest === 'function' && !!candidate.closest(selector);
}

function isInsideLink(target: EventTarget | null): boolean {
	return isInside(target, LINK_SELECTOR);
}

function measureWidth(el: HTMLElement | undefined): number {
	const measurable = el as { offsetWidth?: unknown } | undefined;

	return typeof measurable?.offsetWidth === 'number' ? Math.round(measurable.offsetWidth) : 0;
}

/**
 * 잘린 내용까지 포함한 폭. 레이아웃이 없는 하네스에서는 0 이라 하한으로 떨어진다.
 *
 * `scrollWidth` 는 그 요소가 **스스로 스크롤 컨테이너가 아닐 때만** 넘치는 내용을 알려 준다.
 * 알약 칸은 안쪽 컨테이너가 `overflow-x: auto` 라 거기서 넘침이 끊기고, 부모는 자기 폭만 돌려준다 —
 * 그래서 태그·목록 열이 내용보다 좁게 잡혔다(마스터 9차 3번). 자식의 넘침까지 함께 본다.
 *
 * 자식 폭에 부모 여백을 더해야 셀 폭이 된다. 여백은 `부모 clientWidth − 자식 clientWidth` 로 얻는다 —
 * 자식이 부모 내용 영역을 가득 채우므로 그 차이가 곧 좌우 여백이다.
 */
function measureContent(el: HTMLElement | undefined): number {
	const measurable = el as
		| { scrollWidth?: unknown; clientWidth?: unknown; children?: ArrayLike<unknown> }
		| undefined;
	if (typeof measurable?.scrollWidth !== 'number') return 0;

	let widest = measurable.scrollWidth;
	const children = measurable.children;
	if (typeof measurable.clientWidth !== 'number' || !children) return widest;

	for (let i = 0; i < children.length; i++) {
		const child = children[i] as { scrollWidth?: unknown; clientWidth?: unknown };
		if (typeof child?.scrollWidth !== 'number' || typeof child.clientWidth !== 'number') continue;

		widest = Math.max(widest, child.scrollWidth + (measurable.clientWidth - child.clientWidth));
	}

	return widest;
}

/**
 * 자동 맞춤 폭의 상한. 네이티브 `--bases-table-column-max-width` 와 같은 값이다(app.css:2069) —
 * 아주 긴 제목 하나가 열을 화면 밖까지 늘리지 않게 막는다.
 */
const MAX_AUTO_FIT_WIDTH = 300;


function isRightToLeft(el: HTMLElement): boolean {
	const view = el.ownerDocument?.defaultView;
	if (!view || typeof view.getComputedStyle !== 'function') return false;

	return view.getComputedStyle(el).direction === 'rtl';
}

/** 다시 그린 뒤 그 항목을 맡게 된 손잡이로 포커스를 옮긴다. 요소가 없어졌으면 아무 일도 하지 않는다. */
function focusHandle(el: HTMLElement | undefined): void {
	const target = el as { focus?(): void } | undefined;
	if (typeof target?.focus === 'function') target.focus();
}

function capturePointer(el: HTMLElement | undefined, pointerId: number): void {
	const target = el as { setPointerCapture?(id: number): void } | undefined;
	if (typeof target?.setPointerCapture === 'function') target.setPointerCapture(pointerId);
}

function releasePointer(el: HTMLElement | undefined, pointerId: number): void {
	const target = el as { releasePointerCapture?(id: number): void } | undefined;
	if (typeof target?.releasePointerCapture === 'function') target.releasePointerCapture(pointerId);
}

/**
 * 공개 뷰 옵션에는 숫자 입력 컨트롤이 없다 — d.ts 의 종류는 dropdown·file·folder·formula·multitext·
 * property·slider·text·toggle 뿐이고, 슬라이더 컨트롤은 눈금과 값 표시만 있어 직접 입력이 안 된다
 * (app.js 오프셋 1122885 — `span.slider-value` + `input[type=range]`). 그래서 자유 입력이 되는 text 로 받는다.
 *
 * 행 제한은 **드롭다운 하나**다. F3(전체 페이징)과 F10(그룹 페이징)이 배타라는 규칙이 UI 구조 자체가 되어
 * 잘못된 조합이 표현조차 안 된다(디자인 B1 · 대원칙).
 */
export function tableViewOptions(config: BasesViewConfig, host: PlusTableHost): BasesAllOptions[] {
	const placeholder = (key: string): string =>
		String(resolvePageSize(config?.get(key), host.getDefaultPageSize()));

	return [
		{
			type: 'dropdown',
			key: OPEN_MODE_KEY,
			// 행을 누를 때마다 걸리는 설정이라 가장 자주 바뀐다 — 그래서 맨 위다(G1).
			displayName: t('Open rows with'),
			default: DEFAULT_OPEN_MODE,
			options: openModeChoices(),
		},
		{
			type: 'dropdown',
			key: ROW_LIMIT_KEY,
			displayName: t('Row limit'),
			// 기본이 `Show all` 이다 — 잘라야 할 만큼 큰 base 는 네이티브 툴바의 결과 수 제한이 이미 맡는다(B1).
			default: 'all',
			options: translateChoices(ROW_LIMIT_CHOICES),
		},
		{
			type: 'text',
			key: PAGE_SIZE_KEY,
			displayName: t('Rows per page'),
			// 입력칸은 문자열만 보여 준다(app.js 오프셋 2480068) — 예전 숫자 값은 칸이 비어 보이므로,
			// 비었을 때 실제로 적용되는 값(= 설정 탭 기본값)을 자리표시자로 띄워 화면과 동작이 어긋나지 않게 한다.
			placeholder: placeholder(PAGE_SIZE_KEY),
			shouldHide: () => resolveRowLimit(config) !== 'pages',
		},
		{
			type: 'text',
			key: GROUP_SIZE_KEY,
			// F9 와 F10 이 같은 숫자를 쓴다 — 다른 것은 남은 행에 닿는 방법뿐이다(B1).
			displayName: t('Rows per group'),
			placeholder: placeholder(GROUP_SIZE_KEY),
			shouldHide: () => {
				const mode = resolveRowLimit(config);

				return mode !== 'group-top' && mode !== 'group-pages';
			},
		},
		{
			type: 'toggle',
			key: MANUAL_ORDER_ENABLED_KEY,
			displayName: t('Manual order'),
			default: false,
		},
		{
			type: 'toggle',
			key: GROUP_ORDER_ENABLED_KEY,
			// 행 순서와 **독립된 축**이라 옵션도 따로 둔다(마스터 추가 요구 2026-08-08).
			// 그룹이 없을 때도 감추지 않는다 — 조용히 사라지면 사용자가 옵션을 찾아 헤맨다(C1 과 같은 판단).
			displayName: t('Group manual order'),
			default: false,
		},
	];
}

/**
 * 뷰가 플러그인 쪽에서 얻어야 하는 것 — 설정 탭 값과 그 변경 알림. 플러그인 객체를 통째로 넘기지 않는 이유는
 * 뷰가 설정 저장·다른 기능에 손대지 못하게 하기 위해서다.
 */
export interface PlusTableHost {
	/** 뷰 옵션 `Rows per page`·`Rows per group` 이 비어 있을 때 쓸 값. */
	getDefaultPageSize(): number;
	/** @returns 구독 해제 함수. 뷰가 unload 될 때 호출된다. */
	onSettingsChanged(callback: () => void): () => void;
}

export function createPlusTableRegistration(host: PlusTableHost): BasesViewRegistration {
	return {
		name: t('Plus table'),
		icon: 'table',
		factory: (controller, containerEl) => new PlusTableView(controller, containerEl, host),
		options: (config) => tableViewOptions(config, host),
	};
}

/** @returns Bases 코어 플러그인이 꺼져 있으면 false. */
export function registerPlusTableView(plugin: Plugin, host: PlusTableHost): boolean {
	return plugin.registerBasesView(PLUS_TABLE_VIEW_TYPE, createPlusTableRegistration(host));
}
