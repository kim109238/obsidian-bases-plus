import { Menu, setIcon } from 'obsidian';
import type {
	BasesAllOptions,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	BasesViewRegistration,
	EventRef,
	Plugin,
	QueryController,
	TFile,
} from 'obsidian';
import { PlusTableView, tableViewOptions } from './tableView';
// 날짜 문자열 규칙은 달력과 **한 곳에서** 온다 — 두 뷰가 같은 값을 다르게 읽거나 쓰면 안 된다.
import { formatLikeText as formatLike, parseDateText } from './dateText';
import type { PlusGroupHeading, PlusRow, PlusTableHost } from './tableView';
import type { PagerState, RowPlan } from './rowPlan';
import { readStringList } from './rowPlan';
import { addOpenItem, openTarget } from '../shared/openTarget';
import {
	isEditableProperty,
	readEditableValue,
	registeredPropertyType,
	writeValue,
} from './cellEditor';
import { collectValues } from './valueOrder';
import {
	BAR_COLORS_KEY,
	COLOR_BY_KEY,
	barColorFor,
	openBarColorModal,
	readBarColors,
	resolveBarColors,
	saveBarColors,
} from './barColors';
import {
	ZOOM_LEVELS,
	addUnits,
	atMidnight,
	axisWidth,
	buildRange,
	buildTiers,
	dateAt,
	screenLanguage,
	startOfUnit,
	weekStartFor,
	xOf,
	zoomLevelOf,
} from './timelineAxis';
import type { AxisRange, AxisTier, TimelineUnit, ZoomLevel } from './timelineAxis';
import { t } from '../shared/i18n';

/** `.base` 파일의 `views[].type` 에 그대로 기록된다. 바꾸면 기존 `.base` 가 뷰를 못 찾는다. */
export const PLUS_TIMELINE_VIEW_TYPE = 'bases-plus-timeline';

/**
 * 이 둘은 **화면을 조정하는 옵션이 아니라 화면이 성립하는 조건**이라 뷰 옵션 맨 위에 온다(디자인 H).
 * 정하지 않으면 트랙이 통째로 비어 안내 띠가 대신 선다.
 */
const START_DATE_KEY = 'startDate';
const END_DATE_KEY = 'endDate';
/**
 * 막대 위 글자로 쓸 속성. 비우면 파일 이름이다 — 지금까지의 화면이 기본이다.
 * 왼쪽 표의 열은 네이티브 속성 메뉴가 정하고, **막대 글자는 이 옵션이 정한다**(자리가 둘로 갈리지 않게).
 *
 * **여러 개를 받는다**(마스터 3차 요청). 공개 옵션 종류에 "속성 여럿"이 없어 `multitext` 로 받고 우리가
 * 속성 id 로 해석한다 — 그래프 뷰 명세가 y 속성을 받는 방식과 같은 관례다.
 */
const BAR_LABEL_KEY = 'barLabel';
/**
 * 값 사이 구분자. 쉼표를 쓰지 않는 이유는 **목록 값이 이미 쉼표로 이어지기** 때문이다 —
 * `태그1, 태그2 · 진행중` 처럼 갈라져야 어디까지가 한 속성인지 읽힌다.
 */
const BAR_LABEL_SEPARATOR = ' · ';
/** 배율·판 폭은 화면에서 직접 바꾸는 값이라 옵션 목록에 넣지 않는다 — 설정 창에 또 두면 자리가 둘이 된다(H). */
const UNIT_KEY = 'timelineUnit';
const LABEL_WIDTH_KEY = 'timelineLabelWidth';
/** 연관 행은 **편 것을 저장한다** — 기본이 접힘이라 그쪽이 저장량이 작다(그룹 접기와 반대 방향 · F3). */

const DEFAULT_LABEL_WIDTH = 320;
/** 열 하나가 설 수 있는 폭. 네이티브 `--bases-table-column-min-width` 와 같은 하한이다(D2). */
const MIN_LABEL_WIDTH = 40;
/** 배율이 커지면 짧은 기간이 1px 미만이 된다 — 막대가 사라지지 않게 이만큼은 남긴다. */
const MIN_BAR_WIDTH = 6;
/** 이름은 보이는 구간 왼쪽에서 이만큼 안쪽에서 시작한다(확정 7-4). */
const LABEL_INSET = 8;
/** 움직인 거리가 이보다 작으면 클릭, 넘으면 드래그다(확정 5). */
const DRAG_THRESHOLD = 3;
const LINK_SELECTOR = '.internal-link, a';

const NOTICE_NEEDS_START = 'Choose a start date property to draw the timeline.';
// 안내 문구는 화면에 붙는 자리(`syncNoticeEl`)에서 옮긴다 — 여기서는 원문 그대로 둔다.

/** 트랙 한 줄에 사는 요소들. 행 요소 풀과 같은 순서로 쌓여 재사용된다(성2). */
interface TimelineTrack {
	el: HTMLElement;
	barEl: HTMLElement;
	pointEl: HTMLElement;
	labelEl: HTMLElement;
	startHandleEl: HTMLElement;
	endHandleEl: HTMLElement;
	/** 지금 그리고 있는 막대의 트랙 안 좌표 — 스크롤 때 이름 자리를 이 값으로 다시 잡는다. */
	left: number;
	width: number;
	/** 행의 세로 자리. 스크롤 중에 **보이는 행만** 다시 계산하려고 갱신 때 한 번 잰다(확정 7-4). */
	top: number;
	active: boolean;
	/** 색을 켠 막대는 경계에서 글자색이 갈리지 않는다 — 채움이 옅고 글자가 이미 본문색이다(7-1). */
	tinted: boolean;
	/** 막대 위에 쓸 글자. 기본은 파일 이름이고 `Bar label` 옵션이 정하면 그 속성 값이다. */
	label: string;
	file: TFile | null;
	start: Date | null;
	end: Date | null;
	point: boolean;
}

/** 이번 갱신에 막대 하나가 알아야 할 전부. 트랙 요소와 값이 여기서 만나 DOM 에 붙는다. */
interface BarRow {
	track: TimelineTrack;
	entry: BasesEntry | null;
	file: TFile | null;
	label: string;
	start: Date | null;
	end: Date | null;
}

type GestureKind = 'move' | 'start' | 'end';

interface BarGesture {
	kind: GestureKind;
	pointerId: number;
	track: TimelineTrack;
	startX: number;
	/** 제스처 시작 시점의 날짜 — Escape 로 되돌릴 원본이다. */
	fromStart: Date;
	fromEnd: Date;
	/** 제스처 시작 시점에 종료 날짜가 실제로 있었는지 — 없던 항목에 종료를 만들지 말지 정한다. */
	hadEnd: boolean;
	moved: boolean;
	detachKeys: () => void;
}

interface DividerGesture {
	pointerId: number;
	startX: number;
	startWidth: number;
	moved: boolean;
}

/**
 * 타임라인 — **왼쪽은 확정된 표 그 자체**이고 오른쪽 시간 트랙만 새로 그린다(디자인 결론).
 *
 * 그래서 이 클래스는 표 뷰를 상속한다. 열·셀 편집·그룹 헤딩·행 높이·수동 순서·페이저는 한 줄도 다시
 * 만들지 않고, 표가 열어 둔 네 자리(`createRowCellsEl`·`createRow`·`afterRowAppended`·`afterRender`)에
 * 축·막대·오늘 틴트·연관 행을 얹는다.
 */
export class PlusTimelineView extends PlusTableView {
	type = PLUS_TIMELINE_VIEW_TYPE;

	private readonly scrollEl: HTMLElement;
	private readonly cornerEl: HTMLElement;
	private readonly dividerEl: HTMLElement;
	private readonly axisEl: HTMLElement;
	private readonly toolsEl: HTMLElement;
	private readonly unitLabelEl: HTMLElement;
	private readonly colorButtonEl: HTMLElement;
	private readonly addButtonEl: HTMLElement;
	private readonly tierEls: HTMLElement[] = [];
	/** `this.rows` 와 같은 순서로 쌓인다 — 행 하나가 트랙 하나를 갖는다. */
	private readonly tracks: TimelineTrack[] = [];
	private range: AxisRange | null = null;
	private labelWidth = DEFAULT_LABEL_WIDTH;
	private bar: BarGesture | null = null;
	private divider: DividerGesture | null = null;
	private scrollFrame = 0;
	private folderWatch: EventRef | null = null;
	private folderTimer = 0;

	constructor(controller: QueryController, containerEl: HTMLElement, host: PlusTableHost) {
		super(controller, containerEl, host);

		this.rootEl.addClass('is-timeline');

		// 가로·세로 스크롤을 한 요소가 맡는다(A1) — 왼쪽 판과 머리가 그 안에서 sticky 로 남는다.
		this.scrollEl = this.rootEl.createDiv({ cls: 'bases-plus-timeline' });
		this.scrollEl.appendChild(this.tableEl);
		this.tableEl.addClass('bases-plus-tl-content');
		this.rootEl.appendChild(this.errorEl);

		// 머리 — 왼쪽 위 빈칸(열 이름 줄이 그 **바닥**에 온다)과 축 층을 한 줄에 세운다(A3).
		this.headEl.addClass('bases-plus-tl-head');
		this.cornerEl = this.headEl.createDiv({ cls: 'bases-plus-tl-corner' });
		this.headCellsEl = this.cornerEl.createDiv({ cls: 'bases-plus-tl-corner-cols' });
		this.dividerEl = this.cornerEl.createDiv({ cls: 'bases-plus-tl-divider' });
		this.axisEl = this.headEl.createDiv({ cls: 'bases-plus-tl-axis' });

		this.toolsEl = this.footerEl.createDiv({ cls: 'bases-plus-tl-tools' });
		this.createTool('lucide-zoom-out', t('Zoom out'), () => this.zoom(1));
		// 이름을 누르면 단계를 바로 고른다 — `−`·`+` 로 여섯 번 누르지 않아도 되게(마스터 2차 2번).
		this.unitLabelEl = this.toolsEl.createDiv({ cls: 'bases-plus-tl-unit' });
		this.unitLabelEl.setAttr('role', 'button');
		this.unitLabelEl.setAttr('tabindex', '0');
		this.unitLabelEl.setAttr('aria-label', t('Zoom level'));
		this.registerDomEvent(this.unitLabelEl, 'click', (evt) => this.openZoomMenu(evt));
		this.registerDomEvent(this.unitLabelEl, 'keydown', (evt) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') return;

			evt.preventDefault();
			this.openZoomMenu(evt);
		});
		this.createTool('lucide-zoom-in', t('Zoom in'), () => this.zoom(-1));
		this.createTool('lucide-crosshair', t('Today'), () => this.scrollToToday());
		this.colorButtonEl = this.createTool('lucide-palette', t('Bar colors'), () => this.openBarColors());
		this.addButtonEl = this.createTool('lucide-plus', t('New item'), () => void this.addItem(null));

		this.registerDomEvent(this.dividerEl, 'pointerdown', (evt) => this.onDividerStart(evt));
		this.registerDomEvent(this.dividerEl, 'pointermove', (evt) => this.onDividerMove(evt));
		this.registerDomEvent(this.dividerEl, 'pointerup', (evt) => this.onDividerEnd(evt));
		this.registerDomEvent(this.dividerEl, 'pointercancel', (evt) => this.onDividerEnd(evt));
		this.registerDomEvent(this.scrollEl, 'scroll', () => this.queueLabels());
		// 확대·축소가 **무엇을 고정하는가**가 핵심이다 — 휠은 포인터 아래 날짜를 붙잡는다(B4).
		this.registerDomEvent(this.scrollEl, 'wheel', (evt) => this.onWheel(evt as WheelEvent), {
			passive: false,
		});
	}

	onunload(): void {
		this.cancelBar();
		this.disarmFolderMove();
		super.onunload();
	}

	/**
	 * 계획은 표가 세운다. 여기서 더하는 것은 둘뿐이다 — 날짜 속성이 없을 때의 안내 띠와,
	 * **이번 갱신에 쓸 연관 파일 목록**(행을 붙이는 도중에 필요해 미리 채운다).
	 */
	protected buildPlan(): RowPlan {
		const plan = super.buildPlan();

		if (plan.notice !== null || this.getStartProperty() !== null) return plan;

		return { ...plan, notice: NOTICE_NEEDS_START };
	}

	/** 셀은 **왼쪽 판 안에** 들어간다 — 그 판이 가로 스크롤에도 제자리에 남아야 하기 때문이다(A2). */
	protected createRowCellsEl(rowEl: HTMLElement): HTMLElement {
		rowEl.addClass('bases-plus-tl-row');
		const labelEl = rowEl.createDiv({ cls: 'bases-plus-tl-label' });
		this.tracks.push(this.createTrack(rowEl));

		return labelEl;
	}

	protected createRow(): PlusRow {
		const row = super.createRow();
		return row;
	}

	/** 그룹 헤딩 오른쪽 끝의 `+`. 호버 때만 드러나고, 누르면 **그 그룹의 값을 심어** 만든다(G). */
	protected createHeading(): PlusGroupHeading {
		const heading = super.createHeading();

		/*
		 * 헤딩 글자를 **한 상자에 묶는다.** 조각마다 따로 `sticky` 를 걸면 가로로 스크롤할 때 세 조각이
		 * 같은 x 로 몰려 속성명과 값이 겹쳐 찍힌다(스크롤 400 실측: `Status` 위에 `진행중`).
		 * 묶어 두면 상자 하나가 붙고 안쪽 배치는 그대로 남는다 — 목업도 같은 구조다(`.tl-group-inner`).
		 */
		const innerEl = heading.el.createDiv({ cls: 'bases-plus-tl-group-inner' });
		innerEl.appendChild(heading.toggleEl);
		innerEl.appendChild(heading.propertyEl);
		innerEl.appendChild(heading.valueEl);

		/*
		 * 개수와 `+` 도 한 상자에 묶어 **오른쪽에 정박한다.** 개수만 붙여 두면 그 옆의 `+` 가 상자 밖으로
		 * 밀려 가로 스크롤에서 사라진다(마스터 2차 8번). 둘이 한 덩어리라 사이 간격도 그대로 남는다.
		 */
		const tailEl = heading.el.createDiv({ cls: 'bases-plus-tl-group-tail' });
		tailEl.appendChild(heading.countEl);

		const addEl = tailEl.createDiv({ cls: 'bases-plus-group-add clickable-icon' });
		setIcon(addEl, 'lucide-plus');
		addEl.setAttr('role', 'button');
		addEl.setAttr('tabindex', '0');
		addEl.setAttr('aria-label', t('New item'));

		this.registerDomEvent(addEl, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			void this.addItem(heading.groupId);
		});

		return heading;
	}

	/**
	 * 축·막대·오늘 틴트. 행이 이미 제자리에 있어 좌표를 재도 맞는 유일한 시점이다.
	 */
	protected afterRender(_plan: RowPlan, properties: BasesPropertyId[]): void {
		const startProperty = this.getStartProperty();
		const endProperty = this.getEndProperty();
		const today = atMidnight(new Date());
		const locale = screenLanguage();
		const level = this.getZoom();
		const weekStart = weekStartFor(locale);

		this.labelWidth = this.readLabelWidth();

		const rows = this.collectBars(startProperty, endProperty);
		/*
		 * 축은 **데이터가 요구하는 길이와 화면이 요구하는 길이 중 긴 쪽**이다. 짧으면 오른쪽에 격자도
		 * 행 선도 없는 빈 띠가 남는데, 임베드에서는 폭이 좁아 안 보이고 base 를 직접 열었을 때만 드러난다
		 * (마스터 1차 요청 3번). 눈금 하나를 더 얹어 반 칸이 남지 않게 한다.
		 */
		const trackWidth = Math.max(0, numberOf(this.scrollEl, 'clientWidth') - this.labelWidth);
		const fillUnits = trackWidth > 0 ? trackWidth / level.width + 1 : 0;
		const range = buildRange(datesOf(rows), level, weekStart, today, fillUnits);
		this.range = range;

		this.applyMetrics(range);
		this.syncAxis(buildTiers(range, today, locale));
		this.syncToday(range, today);
		this.syncBars(rows, range, startProperty);
		this.syncTools(level);
		this.measureRows();
		this.updateLabels();
	}

	/** 줌·오늘 컨트롤은 페이저가 없어도 서야 한다 — 푸터를 늘 붙여 둔다. */
	protected syncFooter(pager: PagerState | null): void {
		super.syncFooter(pager);
		this.rootEl.appendChild(this.footerEl);
		this.rootEl.appendChild(this.errorEl);
	}

	// ── 날짜 속성 ────────────────────────────────────────────────────────────────────

	private getStartProperty(): BasesPropertyId | null {
		return this.readProperty(START_DATE_KEY);
	}

	private getEndProperty(): BasesPropertyId | null {
		return this.readProperty(END_DATE_KEY);
	}

	private readProperty(key: string): BasesPropertyId | null {
		try {
			return this.config.getAsPropertyId(key);
		} catch (error) {
			const raw = this.config.get(key);

			return typeof raw === 'string' && raw !== '' ? (raw as BasesPropertyId) : null;
		}
	}

	private getZoom(): ZoomLevel {
		return zoomLevelOf(this.config.get(UNIT_KEY));
	}

	/**
	 * 막대 글자로 쓸 속성들. **예전 단일 저장값(문자열)도 그대로 읽는다** — `property` 옵션으로 고른 값이
	 * `.base` 에 문자열로 남아 있어서, 배열만 받으면 그 뷰의 막대 글자가 조용히 파일 이름으로 돌아간다.
	 * 손으로 고친 `.base` 에서 오는 값이라 관대하게 읽는다(`resolvePageSize` 선례 · F5).
	 */
	private readBarLabelProperties(): BasesPropertyId[] {
		const stored = this.config.get(BAR_LABEL_KEY);
		const lines = Array.isArray(stored) ? stored : typeof stored === 'string' ? [stored] : [];

		return lines
			.filter((line): line is string => typeof line === 'string')
			.map((line) => line.trim())
			.filter((line) => line !== '') as BasesPropertyId[];
	}

	private readLabelWidth(): number {
		const stored = Number(this.config.get(LABEL_WIDTH_KEY));

		return Number.isFinite(stored) && stored >= MIN_LABEL_WIDTH ? Math.round(stored) : DEFAULT_LABEL_WIDTH;
	}

	// ── 막대 ────────────────────────────────────────────────────────────────────────

	/**
	 * 이번에 그릴 막대들. 쿼리 행은 트랙 풀에서 자리를 받고, 연관 행은 자기 트랙을 이미 갖고 있다.
	 * 여기서는 **무엇을 어디에 그릴지만** 정하고 DOM 은 건드리지 않는다.
	 */
	private collectBars(
		startProperty: BasesPropertyId | null,
		endProperty: BasesPropertyId | null
	): BarRow[] {
		const labelProperties = this.readBarLabelProperties();
		const out: BarRow[] = [];

		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const track = this.tracks[i];
			if (!track) continue;

			const entry = row.entry;
			if (!entry || row.el.hidden) {
				out.push({ track, entry: null, file: null, label: '', start: null, end: null });
				continue;
			}

			out.push({
				track,
				entry,
				file: entry.file,
				label: barLabelOf(entry.file, joinLabel(labelProperties.map((prop) => readEditableValue(entry, prop)))),
				start: entryDate(entry, startProperty),
				end: entryDate(entry, endProperty),
			});
		}

		return out;
	}

	private syncBars(rows: BarRow[], range: AxisRange, startProperty: BasesPropertyId | null): void {
		const colorProperty = this.readProperty(COLOR_BY_KEY);
		const order = colorProperty ? this.colorValues(colorProperty) : [];
		const colors = colorProperty ? resolveBarColors(order, readBarColors(this.config)) : new Map();

		for (const row of rows) {
			const { track } = row;
			track.file = row.file;
			track.label = row.label;
			track.start = row.start;
			track.end = row.end;

			// 시작 날짜가 없으면 트랙은 비고 왼쪽 표에는 그대로 나온다 — 오류가 아니다(C4·F3).
			if (!row.start || startProperty === null) {
				track.active = false;
				track.barEl.hide();
				track.pointEl.hide();
				track.labelEl.hide();
				continue;
			}

			const end = row.end && row.end >= row.start ? row.end : null;
			// 시작만 있거나 시작=종료면 점 항목이다 — 배율이 년이면 하루가 1px 미만이라 막대는 사라진다(C4).
			const point = end === null || end.getTime() === row.start.getTime();
			const left = xOf(range, row.start);
			const right = point ? left : xOf(range, addUnits(end as Date, 'day', 1, range.weekStart));

			track.active = true;
			track.point = point;
			track.left = left;
			track.width = point ? 0 : Math.max(MIN_BAR_WIDTH, right - left);

			const slot = row.entry && colorProperty ? barColorFor(row.entry, colorProperty, order, colors) : null;
			track.tinted = slot !== null;

			this.paintBar(track, slot);
		}
	}

	private paintBar(track: TimelineTrack, slot: number | null): void {
		const name = track.label;

		if (track.point) {
			track.barEl.hide();
			track.pointEl.show();
			track.pointEl.setCssStyles({ left: `${track.left}px` });
		} else {
			track.pointEl.hide();
			track.barEl.show();
			track.barEl.setCssStyles({ left: `${track.left}px`, width: `${track.width}px` });
		}

		// 색을 안 켜면 막대는 강조색 하나다 — C1 의 선언 그대로다(확정 8-4).
		track.barEl.toggleClass('is-tinted', slot !== null);
		track.pointEl.toggleClass('is-tinted', slot !== null);
		const paint = slot === null ? '' : `var(--bases-plus-series-${slot})`;
		track.barEl.setCssProps({ '--bases-plus-tl-color': paint });
		track.pointEl.setCssProps({ '--bases-plus-tl-color': paint });

		track.labelEl.setText(name);
		track.labelEl.toggleClass('is-point', track.point);
		track.labelEl.toggleClass('is-tinted', slot !== null);
	}

	/**
	 * 이름의 자리 — **보이는 구간의 왼쪽 + 8px**(확정 7-4 ⓑ). 막대가 조금이라도 보이면 이름이 보이고,
	 * 다 가려지면 이름도 함께 사라진다.
	 *
	 * `sticky` 로는 안 된다 — 트랙이 `overflow: hidden` 이라 스크롤 컨테이너가 되어 안쪽 sticky 가 바깥
	 * 가로 스크롤을 따라가지 않는다(확정 7-3 실측). 그래서 스크롤마다 계산하는 길을 택했고, 대상은
	 * **화면에 보이는 행**뿐이며 `requestAnimationFrame` 으로 묶는다.
	 */
	private updateLabels(): void {
		const scrollLeft = numberOf(this.scrollEl, 'scrollLeft');
		const clientWidth = numberOf(this.scrollEl, 'clientWidth');
		const scrollTop = numberOf(this.scrollEl, 'scrollTop');
		const clientHeight = numberOf(this.scrollEl, 'clientHeight');
		const viewLeft = scrollLeft;
		const viewRight = scrollLeft + Math.max(0, clientWidth - this.labelWidth);
		// 레이아웃이 없는 하네스에서는 전부 0 이라 세로 창을 걸지 않는다 — 모든 행이 대상이 된다.
		const windowed = clientHeight > 0;

		for (const track of this.allTracks()) {
			if (!track.active) continue;
			if (windowed && (track.top + 60 < scrollTop || track.top > scrollTop + clientHeight)) continue;

			const width = track.point ? 12 : track.width;
			const visLeft = Math.max(track.left, viewLeft);
			const visRight = Math.min(track.left + width, viewRight);

			if (visRight - visLeft <= 0 && clientWidth > 0) {
				track.labelEl.hide();
				continue;
			}

			const left = Math.max(track.left, viewLeft) + LABEL_INSET;
			track.labelEl.show();
			track.labelEl.setCssStyles({ left: `${left}px` });

			/*
			 * 글자색은 막대의 오른쪽 끝을 경계로 갈린다(확정 7-1 ㉠). 글자를 두 번 그리는 것이 아니라
			 * 그라디언트를 글자 모양으로 잘라(`background-clip: text`) 한 요소·한 문자열로 두 색을 낸다.
			 * 색을 켠 막대는 채움이 옅고 글자가 이미 본문색이라 경계에서 갈리지 않는다.
			 */
			const inside = track.tinted || track.point ? 0 : Math.max(0, track.left + width - left);
			track.labelEl.setCssProps({ '--bases-plus-tl-ink': `${inside}px` });
		}
	}

	private queueLabels(): void {
		const view = this.rootEl.ownerDocument?.defaultView as
			| { requestAnimationFrame?: (cb: () => void) => number; cancelAnimationFrame?: (id: number) => void }
			| undefined;

		if (typeof view?.requestAnimationFrame !== 'function') {
			this.updateLabels();
			return;
		}

		if (this.scrollFrame) return;

		this.scrollFrame = view.requestAnimationFrame(() => {
			this.scrollFrame = 0;
			this.updateLabels();
		});
	}

	/** 세로 자리를 갱신마다 한 번만 잰다 — 스크롤할 때마다 재면 성1·성2 에 걸린다. */
	private measureRows(): void {
		for (let i = 0; i < this.tracks.length; i++) {
			this.tracks[i].top = numberOf(this.rows[i]?.el, 'offsetTop');
		}

	}

	private *allTracks(): Generator<TimelineTrack> {
		for (const track of this.tracks) yield track;
	}

	// ── 축·오늘·치수 ────────────────────────────────────────────────────────────────

	private applyMetrics(range: AxisRange): void {
		const width = axisWidth(range);

		// **커스텀 속성은 `setCssProps` 로만 들어간다** — `setCssStyles` 는 CSSStyleDeclaration 에 그대로
		// 대입하는 경로라 `--x` 를 조용히 버린다(옵시디언이 통로를 둘로 나눠 둔 이유다).
		this.scrollEl.setCssProps({
			'--bases-plus-tl-label-width': `${this.labelWidth}px`,
			'--bases-plus-tl-unit-width': `${range.width}px`,
			'--bases-plus-tl-axis-width': `${width}px`,
		});
	}

	private syncAxis(tiers: AxisTier[]): void {
		while (this.tierEls.length < tiers.length) {
			this.tierEls.push(this.axisEl.createDiv({ cls: 'bases-plus-tl-tier' }));
		}

		for (let i = 0; i < this.tierEls.length; i++) {
			const tierEl = this.tierEls[i];
			const tier = tiers[i];

			if (!tier) {
				tierEl.hide();
				continue;
			}

			tierEl.show();
			// 맨 아래 층만 열 이름 줄과 같은 30px 이다 — 그래야 두 판의 머리가 한 줄에서 끝난다(A3).
			tierEl.toggleClass('is-last', tier.last);
			tierEl.empty();

			for (const segment of tier.segments) {
				const segEl = tierEl.createDiv({ cls: 'bases-plus-tl-seg' });
				segEl.setCssStyles({ left: `${segment.left}px`, width: `${segment.width}px` });
				const labelEl = segEl.createDiv({ cls: 'bases-plus-tl-seg-label', text: segment.label });
				// 배경만으로는 축에서 어느 칸인지 덜 읽힌다 — 그 날짜 글자를 함께 올린다(B3).
				labelEl.toggleClass('is-today', segment.today);
			}
		}
	}

	/**
	 * 오늘 칸의 자리만 알려 준다 — **그리는 것은 트랙의 배경**이다(3차 4·6번).
	 * 행 전체를 덮는 요소로 두면 그룹 헤딩 줄까지 가로질러, 띠 색이 불투명하다는 가정에만 기대 가려진다.
	 */
	private syncToday(range: AxisRange, today: Date): void {
		const at = startOfUnit(today, range.unit, range.weekStart);

		this.scrollEl.setCssProps({ '--bases-plus-tl-today-left': `${xOf(range, at)}px` });
	}

	private syncTools(level: ZoomLevel): void {
		this.unitLabelEl.setText(levelName(level));
		// 고를 값이 없는 대화상자를 열 수 없게 한다 — `Color by` 가 비면 요소 자체가 없다(H · J1).
		if (this.readProperty(COLOR_BY_KEY)) this.colorButtonEl.show();
		else this.colorButtonEl.hide();

		// 그룹이 없으면 헤딩이 없어 `+` 가 설 자리가 없다 — 그때만 푸터에 하나 둔다(G).
		if (this.getGroupProperty() === null) this.addButtonEl.show();
		else this.addButtonEl.hide();
	}

	// ── 줌·스크롤 ──────────────────────────────────────────────────────────────────

	/**
	 * 배율을 한 단계 옮긴다. **화면 가운데 날짜를 고정**한다 — 왼쪽 끝을 고정하면 보던 날짜가 화면 밖으로
	 * 날아간다(B4).
	 */
	private zoom(step: number, anchorX?: number): void {
		const range = this.range;
		if (!range) return;

		// 단계 목록을 걷는다 — 같은 달력 단위에 폭이 다른 단계가 둘 있어 단위로는 셀 수 없다.
		const at = ZOOM_LEVELS.findIndex((level) => level.id === this.getZoom().id);
		const next = ZOOM_LEVELS[at + step];
		if (!next) return;

		const clientWidth = numberOf(this.scrollEl, 'clientWidth');
		const trackWidth = Math.max(0, clientWidth - this.labelWidth);
		const anchor = anchorX === undefined ? trackWidth / 2 : anchorX;
		const anchorDate = dateAt(range, numberOf(this.scrollEl, 'scrollLeft') + anchor);

		this.config.set(UNIT_KEY, next.id);
		this.onDataUpdated();

		const after = this.range;
		if (!after) return;

		this.setScrollLeft(xOf(after, anchorDate) - anchor);
	}

	/**
	 * 배율 메뉴. 사다리 이름을 그대로 항목으로 내고 지금 단계에 체크를 둔다 — 어디에 있는지가 목록에서 읽힌다.
	 * 고른 단계로 바로 뛸 때도 **화면 가운데 날짜를 고정**한다(`−`·`+` 와 같은 계약 · B4).
	 */
	private openZoomMenu(evt: Event): void {
		evt.preventDefault();

		const current = this.getZoom();
		const menu = new Menu();

		for (const level of ZOOM_LEVELS) {
			menu.addItem((item) =>
				item
					.setTitle(levelName(level))
					.setChecked(level.id === current.id)
					.onClick(() => this.zoomTo(level))
			);
		}

		const mouse = evt as MouseEvent;
		if (typeof mouse.clientX === 'number') {
			menu.showAtMouseEvent(mouse);
			return;
		}

		// 키보드로 열었을 때 — 이름 위에 세운다. 0,0 에 띄우면 화면 구석에서 열려 맥락을 잃는다.
		const box = this.unitLabelEl.getBoundingClientRect();
		menu.showAtPosition({ x: box.left, y: box.top });
	}

	private zoomTo(level: ZoomLevel): void {
		const at = ZOOM_LEVELS.findIndex((item) => item.id === this.getZoom().id);
		const to = ZOOM_LEVELS.findIndex((item) => item.id === level.id);
		if (at === -1 || to === -1 || at === to) return;

		this.zoom(to - at);
	}

	private onWheel(evt: WheelEvent): void {
		if (!evt.ctrlKey && !evt.metaKey) return;

		evt.preventDefault();
		const box = rectOf(this.scrollEl);
		const anchor = box ? evt.clientX - box.left - this.labelWidth : undefined;

		this.zoom(evt.deltaY > 0 ? 1 : -1, anchor === undefined ? undefined : Math.max(0, anchor));
	}

	/** 오늘로 이동. 배율은 그대로다(B4). */
	private scrollToToday(): void {
		const range = this.range;
		if (!range) return;

		const clientWidth = numberOf(this.scrollEl, 'clientWidth');
		const trackWidth = Math.max(0, clientWidth - this.labelWidth);
		const at = xOf(range, startOfUnit(atMidnight(new Date()), range.unit, range.weekStart));

		this.setScrollLeft(at - trackWidth / 2);
	}

	private setScrollLeft(value: number): void {
		const target = this.scrollEl as unknown as { scrollLeft?: number };
		if (typeof target.scrollLeft !== 'number') return;

		target.scrollLeft = Math.max(0, Math.round(value));
		this.updateLabels();
	}

	// ── 판 경계 폭 조절 ─────────────────────────────────────────────────────────────

	private onDividerStart(evt: PointerEvent): void {
		if (evt.button !== 0 || this.divider) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.divider = {
			pointerId: evt.pointerId,
			startX: evt.clientX,
			startWidth: this.labelWidth,
			moved: false,
		};
		this.dividerEl.addClass('is-active');
		capturePointer(this.dividerEl, evt.pointerId);
	}

	private onDividerMove(evt: PointerEvent): void {
		const gesture = this.divider;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		evt.preventDefault();
		// 상한은 뷰 폭의 절반이다 — 왼쪽 판이 트랙을 다 먹지 않게 막는다(D2).
		const clientWidth = numberOf(this.scrollEl, 'clientWidth');
		const max = clientWidth > 0 ? Math.round(clientWidth / 2) : Number.MAX_SAFE_INTEGER;
		const width = Math.min(max, Math.max(MIN_LABEL_WIDTH, Math.round(gesture.startWidth + (evt.clientX - gesture.startX))));

		if (width === this.labelWidth) return;

		gesture.moved = true;
		this.labelWidth = width;
		this.scrollEl.setCssProps({ '--bases-plus-tl-label-width': `${width}px` });
		this.updateLabels();
	}

	/** 놓을 때 한 번 저장한다 — 끄는 동안 저장하면 임베드에서 호스트 노트를 그만큼 다시 쓴다(D2). */
	private onDividerEnd(evt: PointerEvent): void {
		const gesture = this.divider;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		this.divider = null;
		this.dividerEl.removeClass('is-active');
		releasePointer(this.dividerEl, evt.pointerId);

		if (!gesture.moved) return;

		this.config.set(LABEL_WIDTH_KEY, this.labelWidth);
	}

	// ── 막대 드래그 ────────────────────────────────────────────────────────────────

	private createTrack(rowEl: HTMLElement): TimelineTrack {
		const el = rowEl.createDiv({ cls: 'bases-plus-tl-track' });
		const barEl = el.createDiv({ cls: 'bases-plus-tl-bar' });
		const pointEl = el.createDiv({ cls: 'bases-plus-tl-point' });
		const labelEl = el.createDiv({ cls: 'bases-plus-tl-bar-label' });
		// 손잡이는 **이름보다 위 층**에 둔다 — 이름이 손잡이를 덮으면 기간을 못 고친다(확정 7-1).
		const startHandleEl = barEl.createDiv({ cls: 'bases-plus-tl-bar-handle mod-start' });
		const endHandleEl = barEl.createDiv({ cls: 'bases-plus-tl-bar-handle mod-end' });
		/*
		 * 점 항목에도 끝단 손잡이를 준다(마스터 1차 요청 2번 — "시작과 종료일이 같아도 날짜 수정이 가능하면").
		 * 다이아몬드는 12px 이고 45도 돌아 있어 히트 영역이 작다 — 손잡이를 그 좌우 바깥에 따로 세워
		 * **점을 끌어 기간으로 늘릴 수 있게** 한다. 막대 손잡이와 같은 두께·같은 커서다.
		 */
		const pointStartEl = pointEl.createDiv({ cls: 'bases-plus-tl-point-handle mod-start' });
		const pointEndEl = pointEl.createDiv({ cls: 'bases-plus-tl-point-handle mod-end' });

		const track: TimelineTrack = {
			el,
			barEl,
			pointEl,
			labelEl,
			startHandleEl,
			endHandleEl,
			left: 0,
			width: 0,
			top: 0,
			active: false,
			tinted: false,
			label: '',
			file: null,
			start: null,
			end: null,
			point: false,
		};

		barEl.hide();
		pointEl.hide();
		labelEl.hide();

		this.bindBar(track, barEl, 'move');
		this.bindBar(track, startHandleEl, 'start');
		this.bindBar(track, endHandleEl, 'end');
		this.bindBar(track, pointEl, 'move');
		this.bindBar(track, pointStartEl, 'start');
		this.bindBar(track, pointEndEl, 'end');
		// 날짜가 없는 행은 트랙이 비어 있다 — 그 빈자리를 누르면 그 날짜로 시작을 잡는다(마스터 1차 요청 1번).
		this.registerDomEvent(el, 'click', (evt) => this.onEmptyTrackClick(track, evt));

		return track;
	}

	private bindBar(track: TimelineTrack, el: HTMLElement, kind: GestureKind): void {
		this.registerDomEvent(el, 'pointerdown', (evt) => this.onBarStart(track, kind, evt));
		this.registerDomEvent(el, 'pointermove', (evt) => this.onBarMove(evt));
		this.registerDomEvent(el, 'pointerup', (evt) => this.onBarEnd(evt));
		this.registerDomEvent(el, 'pointercancel', () => this.cancelBar());
		this.registerDomEvent(el, 'contextmenu', (evt) => {
			if (evt.defaultPrevented || !track.file) return;

			evt.preventDefault();
			const menu = new Menu();
			addOpenItem(menu, this.app, track.file, this.getOpenMode());
			menu.showAtMouseEvent(evt);
		});
	}

	private onBarStart(track: TimelineTrack, kind: GestureKind, evt: PointerEvent): void {
		if (evt.button !== 0 || this.bar || !track.active || !track.start) return;
		// 종료 속성을 안 정했으면 고칠 끝이 없다 — 통째 이동만 남는다(C3).
		if (kind !== 'move' && this.getEndProperty() === null) return;

		evt.preventDefault();
		evt.stopPropagation();

		this.bar = {
			kind,
			pointerId: evt.pointerId,
			track,
			startX: evt.clientX,
			fromStart: track.start,
			fromEnd: track.end ?? track.start,
			// 원래 종료가 없던 항목을 그냥 옮겼다고 종료를 새로 만들지 않는다 — 끝을 끌었을 때만 생긴다.
			hadEnd: track.end !== null,
			moved: false,
			detachKeys: this.watchEscape(),
		};

		track.barEl.addClass('is-dragging');
		capturePointer(evt.target as HTMLElement, evt.pointerId);
	}

	private onBarMove(evt: PointerEvent): void {
		const gesture = this.bar;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		const moved = Math.abs(evt.clientX - gesture.startX);
		// 막대를 누르면 그 노트가 열리므로 드래그와 구분해야 한다 — 3px 이 그 경계다(확정 5).
		if (!gesture.moved && moved < DRAG_THRESHOLD) return;

		evt.preventDefault();
		gesture.moved = true;
		this.previewBar(gesture, evt.clientX - gesture.startX);
	}

	private onBarEnd(evt: PointerEvent): void {
		const gesture = this.bar;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		const { track } = gesture;
		this.finishBar();

		if (!gesture.moved) {
			// 움직이지 않았으면 클릭이다 — 왼쪽 이름 링크와 **같은 방식**으로 연다(확정 5).
			if (track.file) void openTarget(this.app, track.file, this.getOpenMode());
			return;
		}

		const next = this.nextDates(gesture, evt.clientX - gesture.startX);
		void this.writeDates(track, next.start, next.end, gesture.hadEnd || gesture.kind === 'end');
	}

	/** Escape·pointercancel — 원위치로 두고 저장하지 않는다(C3). */
	private cancelBar(): void {
		const gesture = this.bar;
		if (!gesture) return;

		const { track } = gesture;
		this.finishBar();

		track.start = gesture.fromStart;
		track.end = gesture.fromEnd;
		if (this.range) this.layoutBar(track, this.range);
		this.updateLabels();
	}

	private finishBar(): void {
		const gesture = this.bar;
		if (!gesture) return;

		this.bar = null;
		gesture.detachKeys();
		gesture.track.barEl.removeClass('is-dragging');
	}

	/** 끄는 동안 화면만 먼저 움직인다 — 저장은 놓을 때 한 번이다(C3). */
	private previewBar(gesture: BarGesture, deltaX: number): void {
		const range = this.range;
		if (!range) return;

		const next = this.nextDates(gesture, deltaX);
		gesture.track.start = next.start;
		gesture.track.end = next.end;
		this.layoutBar(gesture.track, range);
		this.updateLabels();
	}

	/**
	 * 끈 거리를 날짜로 바꾼다. **눈금 단위로 스냅**하고, 끝을 시작보다 앞으로 끌면 최소 1단위에서 멈춘다 —
	 * 뒤집힌 기간을 만들지 않는다(C3).
	 */
	private nextDates(gesture: BarGesture, deltaX: number): { start: Date; end: Date } {
		const range = this.range;
		if (!range) return { start: gesture.fromStart, end: gesture.fromEnd };

		const steps = Math.round(deltaX / range.width);

		if (gesture.kind === 'move') {
			return {
				start: shiftDate(gesture.fromStart, range.unit, steps),
				end: shiftDate(gesture.fromEnd, range.unit, steps),
			};
		}

		if (gesture.kind === 'start') {
			const start = shiftDate(gesture.fromStart, range.unit, steps);

			return { start: start > gesture.fromEnd ? gesture.fromEnd : start, end: gesture.fromEnd };
		}

		const end = shiftDate(gesture.fromEnd, range.unit, steps);

		return { start: gesture.fromStart, end: end < gesture.fromStart ? gesture.fromStart : end };
	}

	private layoutBar(track: TimelineTrack, range: AxisRange): void {
		if (!track.start) return;

		const end = track.end && track.end >= track.start ? track.end : null;
		const point = end === null || end.getTime() === track.start.getTime();
		const left = xOf(range, track.start);
		const right = point ? left : xOf(range, addUnits(end as Date, 'day', 1, range.weekStart));

		track.point = point;
		track.left = left;
		track.width = point ? 0 : Math.max(MIN_BAR_WIDTH, right - left);

		if (point) {
			track.barEl.hide();
			track.pointEl.show();
			track.pointEl.setCssStyles({ left: `${left}px` });
		} else {
			track.pointEl.hide();
			track.barEl.show();
			track.barEl.setCssStyles({ left: `${left}px`, width: `${track.width}px` });
		}
	}

	/**
	 * 놓았을 때 한 번 쓴다 — 셀 편집과 **같은 API·같은 타이밍**이다(C3). 시각이 붙어 있던 값은 시각을 지킨다.
	 */
	private async writeDates(track: TimelineTrack, start: Date, end: Date, writeEnd: boolean): Promise<void> {
		const file = track.file;
		const startProperty = this.getStartProperty();
		const endProperty = this.getEndProperty();
		if (!file || !startProperty) return;

		const before = this.originalText(file, startProperty);
		await writeValue(this.app, file, startProperty, formatLike(before, start));

		if (endProperty && writeEnd) {
			const beforeEnd = this.originalText(file, endProperty);
			await writeValue(this.app, file, endProperty, formatLike(beforeEnd, end));
		}

		this.onDataUpdated();
	}

	/**
	 * 빈 트랙 클릭 — 그 자리의 날짜로 **시작만** 잡는다(마스터 1차 요청 1번).
	 *
	 * 종료까지 함께 넣지 않는 이유는 사용자가 말하지 않은 값을 만들지 않기 위해서다. 시작만 있으면
	 * 다이아몬드가 서고, 그 끝단을 끌면 기간이 된다 — "눌러 놓고 끌어 늘린다"로 이야기가 하나로 이어진다.
	 */
	private onEmptyTrackClick(track: TimelineTrack, evt: MouseEvent): void {
		const range = this.range;
		const startProperty = this.getStartProperty();
		// 막대가 있는 트랙은 막대가 클릭을 받는다 — 빈자리에서만 동작한다.
		if (!range || !startProperty || track.active || !track.file) return;
		if (evt.button !== 0 || evt.defaultPrevented || this.bar) return;

		const box = rectOf(track.el);
		if (!box) return;

		evt.preventDefault();
		evt.stopPropagation();

		const at = startOfUnit(dateAt(range, evt.clientX - box.left), range.unit, range.weekStart);
		void this.writeDates(track, at, at, false);
	}

	private originalText(file: TFile, property: BasesPropertyId): string {
		const entry = (this.data?.data ?? []).find((candidate) => candidate.file?.path === file.path);

		return entry ? readEditableValue(entry, property) : '';
	}

	private watchEscape(): () => void {
		const doc = this.rootEl.ownerDocument as
			| { addEventListener?: Function; removeEventListener?: Function }
			| undefined;
		if (!doc || typeof doc.addEventListener !== 'function') return () => {};

		const onKey = (evt: KeyboardEvent): void => {
			if (evt.key !== 'Escape') return;

			evt.preventDefault();
			this.cancelBar();
		};

		doc.addEventListener('keydown', onKey, true);

		return () => {
			if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKey, true);
		};
	}

	// ── 색 대화상자 ────────────────────────────────────────────────────────────────

	private colorValues(property: BasesPropertyId): string[] {
		return collectValues(this.data?.data ?? [], property, Array.from(readBarColors(this.config).keys()));
	}

	/**
	 * 색 대화상자의 진입점이 **푸터 버튼**인 것은 공개 뷰 옵션에 버튼 종류가 없기 때문이다 —
	 * `BasesOptions` 는 dropdown·file·folder·formula·multitext·property·slider·text·toggle 뿐이다.
	 * `Color by` 가 비면 이 버튼 자체가 없다(H 의 감춤 조건 그대로).
	 */
	private openBarColors(): void {
		const property = this.readProperty(COLOR_BY_KEY);
		if (!property) return;

		openBarColorModal({
			app: this.app,
			title: this.config.getDisplayName(property),
			values: this.colorValues(property),
			colors: readBarColors(this.config),
			onChange: (colors) => {
				saveBarColors(this.config, colors);
				this.onDataUpdated();
			},
		});
	}

	// ── 항목 추가 ──────────────────────────────────────────────────────────────────

	/**
	 * 그 그룹의 값을 심어 만든다. **폴더 그룹만 자리를 정하지 못한다** — `frontmatterProcessor` 는
	 * 프론트매터만 만지고 생성 위치는 네이티브 설정이 정하므로, 만든 뒤 그 폴더로 옮긴다(확정 6).
	 */
	private async addItem(groupId: string | null): Promise<void> {
		const property = this.getGroupProperty();
		const folder = property === 'file.folder' && groupId ? groupId : null;

		if (folder !== null) this.armFolderMove(folder);

		try {
			await this.createFileForView(undefined, (frontmatter: Record<string, unknown>) =>
				seedGroupValue(this.app, frontmatter, property, groupId)
			);
		} catch (error) {
			console.error('Bases Plus: creating the item failed.', error);
			this.disarmFolderMove();
		}
	}

	private armFolderMove(folder: string): void {
		this.disarmFolderMove();

		this.folderWatch = this.app.vault.on('create', (file) => {
			this.disarmFolderMove();
			const target = file as TFile;
			const name = target?.name;
			if (!name) return;

			const path = folder === '' ? name : `${folder}/${name}`;
			// 안 옮기면 그 그룹에 추가한 항목이 **다른 그룹에 나타난다**(확정 6).
			void this.app.fileManager.renameFile(target, path).catch((error) => {
				console.error('Bases Plus: moving the new item into its folder failed.', error);
			});
		});

		const view = this.rootEl.ownerDocument?.defaultView as { setTimeout?: Function } | undefined;
		if (typeof view?.setTimeout === 'function') {
			this.folderTimer = view.setTimeout(() => this.disarmFolderMove(), 60000) as unknown as number;
		}
	}

	private disarmFolderMove(): void {
		if (this.folderWatch) {
			this.app.vault.offref(this.folderWatch);
			this.folderWatch = null;
		}

		const view = this.rootEl.ownerDocument?.defaultView as { clearTimeout?: Function } | undefined;
		if (this.folderTimer && typeof view?.clearTimeout === 'function') view.clearTimeout(this.folderTimer);
		this.folderTimer = 0;
	}

	// ── 푸터 도구 ──────────────────────────────────────────────────────────────────

	private createTool(icon: string, label: string, onClick: () => void): HTMLElement {
		const el = this.toolsEl.createEl('button', {
			cls: 'bases-plus-tl-tool clickable-icon',
			attr: { type: 'button', 'aria-label': label },
		});
		setIcon(el, icon);
		this.registerDomEvent(el, 'click', (evt) => {
			evt.preventDefault();
			onClick();
		});

		return el;
	}
}

/**
 * 배율 이름은 **우리 컨트롤 이름**이라 영어로 둔다(확정 D3-B). 같은 달력 단위의 넓은 단계는 `+` 를 붙여
 * 두 단계가 이름으로도 갈리게 한다 — 눌렀는데 이름이 안 바뀌면 아무 일도 안 일어난 것으로 읽힌다.
 */
function levelName(level: ZoomLevel): string {
	const base = t({ day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }[level.unit]);

	return level.id.endsWith('-wide') ? `${base} +` : base;
}

/**
 * 값이 있는 것만 이어 붙인다 — 빈 속성이 섞여도 구분자가 홀로 남지 않는다(`· 진행중` 같은 꼴을 안 만든다).
 * 속성이 아닌 줄은 값이 비어 그 줄만 조용히 빠진다(그래프 뷰 명세와 같은 규칙).
 */
function joinLabel(values: string[]): string {
	return values.map((value) => value.trim()).filter((value) => value !== '').join(BAR_LABEL_SEPARATOR);
}

/** 고른 속성이 전부 비어 있으면 파일 이름으로 떨어진다 — 막대가 이름 없이 서는 상태를 만들지 않는다. */
function barLabelOf(file: TFile | null, text: string): string {
	const trimmed = text.trim();

	return trimmed !== '' ? trimmed : file?.basename ?? '';
}

function entryDate(entry: BasesEntry, property: BasesPropertyId | null): Date | null {
	if (!property) return null;

	return parseDateText(readEditableValue(entry, property));
}

function datesOf(
	rows: { start: Date | null; end: Date | null }[]
): Date[] {
	const out: Date[] = [];
	for (const row of rows) {
		if (row.start) out.push(row.start);
		if (row.end) out.push(row.end);
	}

	return out;
}

/**
 * 눈금 단위로 옮기되 **날짜의 일자는 지킨다** — 월 배율에서 8월 3일을 한 칸 옮기면 9월 3일이지
 * 9월 1일이 아니다. `addUnits` 는 눈금 경계로 내리는 함수라 여기에는 맞지 않는다.
 */
function shiftDate(date: Date, unit: TimelineUnit, steps: number): Date {
	switch (unit) {
		case 'day':
			return new Date(date.getFullYear(), date.getMonth(), date.getDate() + steps);
		case 'week':
			return new Date(date.getFullYear(), date.getMonth(), date.getDate() + steps * 7);
		case 'month':
			return new Date(date.getFullYear(), date.getMonth() + steps, date.getDate());
		case 'quarter':
			return new Date(date.getFullYear(), date.getMonth() + steps * 3, date.getDate());
		default:
			return new Date(date.getFullYear() + steps, date.getMonth(), date.getDate());
	}
}

/**
 * 새 항목에 그룹 값을 심는다. 태그 그룹은 콜백만으로 끝나고(확정 6), 목록 타입은 배열로 넣어야
 * 프론트매터가 네이티브와 같은 모양이 된다.
 */
function seedGroupValue(
	app: PlusTimelineView['app'],
	frontmatter: Record<string, unknown>,
	property: BasesPropertyId | null,
	groupId: string | null
): void {
	if (!property || groupId === null || groupId === '') return;

	if (property === 'file.tags') {
		frontmatter.tags = [groupId.replace(/^#/, '')];
		return;
	}

	if (!isEditableProperty(property)) return;

	const name = String(property).slice(String(property).indexOf('.') + 1);
	const type = registeredPropertyType(app, property);

	frontmatter[name] = type === 'multitext' || type === 'tags' || type === 'aliases' ? [groupId] : groupId;
}

function numberOf(el: HTMLElement | undefined, key: string): number {
	const value = (el as unknown as Record<string, unknown> | undefined)?.[key];

	return typeof value === 'number' ? value : 0;
}

function childrenOf(el: HTMLElement): HTMLElement[] {
	const children = (el as unknown as { children?: ArrayLike<HTMLElement> }).children;

	return children ? Array.from(children) : [];
}

function rectOf(el: HTMLElement): { left: number } | null {
	const measurable = el as { getBoundingClientRect?: () => { left: number } };

	return typeof measurable.getBoundingClientRect === 'function' ? measurable.getBoundingClientRect() : null;
}

function isInside(target: EventTarget | null, selector: string): boolean {
	const candidate = target as { closest?(selector: string): unknown } | null;

	return !!candidate && typeof candidate.closest === 'function' && !!candidate.closest(selector);
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
 * 뷰 옵션 — 표의 것을 그대로 두고 타임라인 것만 더한다(H).
 * 날짜 속성 둘이 **맨 위**인 이유는 이걸 정하지 않으면 화면이 비어 있기 때문이다.
 */
function timelineViewOptions(config: BasesViewConfig, host: PlusTableHost): BasesAllOptions[] {
	return ([
		{ type: 'property', key: START_DATE_KEY, displayName: t('Start date') },
		{ type: 'property', key: END_DATE_KEY, displayName: t('End date') },
	] as BasesAllOptions[])
		.concat(tableViewOptions(config, host))
		.concat([
			{ type: 'property', key: COLOR_BY_KEY, displayName: t('Color by') },
			{
				type: 'multitext',
				key: BAR_LABEL_KEY,
				// 한 줄에 속성 하나. 비우면 파일 이름이다.
				displayName: t('Bar label'),
			},
		] as BasesAllOptions[]);
}

export function createPlusTimelineRegistration(host: PlusTableHost): BasesViewRegistration {
	return {
		name: t('Plus timeline'),
		// 코어가 간트·기간에 쓰는 그 글리프다.
		icon: 'gantt-chart',
		factory: (controller, containerEl) => new PlusTimelineView(controller, containerEl, host),
		options: (config) => timelineViewOptions(config, host),
	};
}

/** @returns Bases 코어 플러그인이 꺼져 있으면 false. */
export function registerPlusTimelineView(plugin: Plugin, host: PlusTableHost): boolean {
	return plugin.registerBasesView(PLUS_TIMELINE_VIEW_TYPE, createPlusTimelineRegistration(host));
}

export { BAR_COLORS_KEY, LABEL_WIDTH_KEY, START_DATE_KEY, END_DATE_KEY, UNIT_KEY };
