import { BasesView, Menu, setIcon } from 'obsidian';
import type {
	App,
	BasesAllOptions,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	BasesViewRegistration,
	Plugin,
	QueryController,
	TFile,
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
import {
	beginCellEdit,
	isListProperty,
	readEditableValue,
	registeredPropertyType,
	resolveEditableKind,
	toggleCheckbox,
	writeValue,
} from './cellEditor';
import type { EditableKind } from './cellEditor';
import { collectValues } from './valueOrder';
import {
	COLOR_BY_KEY,
	barColorFor,
	openBarColorModal,
	readBarColors,
	resolveBarColors,
	saveBarColors,
} from './barColors';
import { createErrorEl, createNoticeEl, showViewError, syncNoticeEl } from './viewShell';
import { formatDateText, formatLikeText, parseDateText } from './dateText';
import { atMidnight, screenLanguage, weekStartFor } from './timelineAxis';
import {
	CALENDAR_MODE_CHOICES,
	WEEK_START_CHOICES,
	bucketByWeek,
	buildPeriod,
	layoutWeek,
	shiftPeriod,
	weekdayNames,
} from './calendarGrid';
import type { CalendarItem, CalendarMode, CalendarPeriod, CalendarPlacement } from './calendarGrid';
import { CalendarTaskSource } from './calendarTasks';
import type { CalendarTask } from './calendarTasks';
import { openPeriodPicker } from './calendarPeriodPicker';
import { t, translateChoices } from '../shared/i18n';

/** `.base` 파일의 `views[].type` 에 그대로 기록된다. 바꾸면 기존 `.base` 가 뷰를 못 찾는다. */
export const PLUS_CALENDAR_VIEW_TYPE = 'bases-plus-calendar';

/**
 * 날짜 속성 키는 **타임라인과 같은 이름**이다 — 한 base 에서 뷰 종류를 바꿔도 고른 속성이 살아 있다.
 * 이 둘은 화면을 조정하는 옵션이 아니라 화면이 성립하는 조건이라 옵션 맨 위에 온다(디자인 F).
 */
const START_DATE_KEY = 'startDate';
const END_DATE_KEY = 'endDate';
/** 월·주 전환. `view` 는 `.base` 의 예약 이름과 헷갈리므로 접두사를 붙인다. */
const MODE_KEY = 'calendarView';
const ITEMS_PER_DAY_KEY = 'itemsPerDay';
const WEEK_START_KEY = 'weekStart';
const WRAP_KEY = 'wrapItems';
const SHOW_TASKS_KEY = 'showTasks';
/** 칩 제목 앞에 서는 체크박스 속성(마스터 1차 요청 — "title prefix"). */
const CHECKBOX_KEY = 'checkboxProperty';
/** 체크박스 속성이 **없는 노트**에도 체크박스를 세울지(마스터 2차 11번 하위). */
const CHECKBOX_MISSING_KEY = 'checkboxWhenMissing';
/** 칩에서 값을 바로 고르는 목록 속성(마스터 1차 요청 — 예 `status`). */
const LIST_KEY = 'listProperty';
/** 속성 줄을 이름과 함께 볼지, 값만 한 줄로 볼지(마스터 2차 10번). */
const PROPERTY_DISPLAY_KEY = 'propertyDisplay';
/** 값이 빈 속성도 줄을 세울지(마스터 2차 10번). */
const SHOW_EMPTY_KEY = 'showEmptyProperties';
/** 열기 방식은 표와 **같은 키**다 — 뷰를 바꿔도 고른 방식이 그대로 산다. */
const OPEN_MODE_KEY = 'openMode';

const DEFAULT_ITEMS_PER_DAY = 3;
/** 끈 직후 이만큼은 클릭을 열기로 보지 않는다. 사람 손으로는 구분되지 않는 길이다. */
const CLICK_AFTER_DRAG_MS = 250;
/** 주 보기는 `+N` 없이 전부 보여 주고 줄을 최소 이만큼 잡는다(마스터 1차 요청). */
const WEEK_MIN_LANES = 7;

const NOTICE_NEEDS_START = 'Choose a start date property to draw the calendar.';
/** 임베드에서 잘릴 때의 권고. 한 주는 1행이라 어디에 넣어도 잘리지 않는다(디자인 A4). */
const NOTICE_EMBED_TALLER =
	'This calendar is taller than the embed. Set a height on the embed or use week view.';

/** 태스크 상태 글리프. 상태를 색이 아니라 **글리프가 말한다**(디자인 D2). */
const TASK_GLYPHS: Record<string, string> = { todo: '☐', done: '☑', cancelled: '☒' };

/** 속성 줄 표시 방식. 우리 컨트롤 이름이라 영어다(확정 D3-B). */
const PROPERTY_DISPLAY_CHOICES: Record<string, string> = {
	names: 'Name and value',
	values: 'Values only',
};

/** 칩 안에서 **바로 고칠 수 있는 타입**(마스터 2차 10번). 나머지는 값을 보여 주기만 한다. */
const INLINE_EDITABLE: EditableKind[] = ['list', 'date', 'datetime', 'checkbox'];

/** 주 하나가 그리드로 선다 — **줄이 곧 행**이라 같은 줄의 높이가 구조적으로 하나가 된다(1차 16·22번). */
interface WeekEl {
	el: HTMLElement;
	/** 배경·상태(오늘·주말·달 밖)를 지는 칸. 줄 전체를 가로질러 깔린다. */
	days: HTMLElement[];
	heads: DayHead[];
	slots: SlotEl[];
	/** 칸별 `+N`. 7개를 풀로 들고 필요한 칸만 보인다. */
	mores: HTMLElement[];
	/** 이 주가 기간에서 몇 번째인가 — `+N` 이 어느 줄을 펼칠지 정한다. */
	index: number;
	/** 이 주의 첫 날 — 포인터가 선 칸을 날짜로 되돌린다(주 경계를 넘는 드래그). */
	firstDate: Date | null;
}

/** 날짜 숫자와 추가 버튼 — **항목이 있든 없든 같은 자리**에 선다(마스터 1차 19번). */
interface DayHead {
	el: HTMLElement;
	numEl: HTMLElement;
	addEl: HTMLElement;
	date: Date | null;
}

interface SlotEl {
	el: HTMLElement;
	/** 파일 칩. 속성을 켜면 카드처럼 자란다(1차 요청 — 이름·값 목록이 칩 **안**에). */
	itemEl: HTMLElement;
	headEl: HTMLElement;
	checkEl: HTMLElement;
	itemTextEl: HTMLElement;
	pillEl: HTMLElement;
	propsEl: HTMLElement;
	/** 속성 줄 풀. 갱신마다 다시 만들지 않는다(성2). */
	propRows: PropRow[];
	/** 기간 끝단 손잡이. **실제 시작·끝 조각에만** 보인다 — 주 경계에서 잘린 쪽은 그 끝이 아니다. */
	startHandleEl: HTMLElement;
	endHandleEl: HTMLElement;
	/** 태스크 줄(배경 없는 평면). */
	taskEl: HTMLElement;
	markEl: HTMLElement;
	taskTextEl: HTMLElement;
	item: CalendarItem | null;
	/** 이번 갱신에 이 슬롯이 잡은 자리 — 끝단 드래그가 미리보기를 이 값에서 만든다. */
	placement: CalendarPlacement | null;
	/** 이 슬롯이 속한 주의 첫 날 — 끌어서 얻은 칸 번호를 날짜로 되돌린다. */
	weekStart: Date | null;
}

/** 칩 안 속성 한 줄. 값이 고칠 수 있는 타입이면 그 자리에서 편집기가 뜬다(2차 10번). */
interface PropRow {
	el: HTMLElement;
	nameEl: HTMLElement;
	valueEl: HTMLElement;
	/** 체크박스 값은 **우리 글리프**로 그린다 — 코어 입력칸은 이 자리에서 찌그러진다(3차 4번 ⓒ·8번). */
	checkEl: HTMLElement;
	property: BasesPropertyId | null;
	entry: BasesEntry | null;
	kind: EditableKind | null;
}

/**
 * 드래그 한 번. 계약은 타임라인 그대로다 — 하루 스냅·Esc 취소·놓을 때 한 번 저장.
 *
 * **요소가 아니라 항목 id 를 잡는다.** 미리보기가 그리드를 다시 배치하면 슬롯 요소는 풀에서 다른 항목을
 * 맡게 되므로, 요소를 들고 있으면 놓는 순간 엉뚱한 노트에 쓴다(3차 11번 ⓐ 계열의 사고).
 */
interface ItemDrag {
	itemId: string;
	kind: 'start' | 'end';
	pointerId: number;
	fromStart: Date;
	fromEnd: Date;
	moved: boolean;
	detachKeys: () => void;
}

/**
 * 달력 — **새로 그리는 것은 7열 그리드와 칸 안 배치뿐이다**(디자인 결론).
 * 막대·오늘 틴트는 타임라인에서, 이동 버튼·열기·속성 렌더·안내 띠는 표에서 가져온다.
 *
 * 표를 상속하지 않는다. 달력은 열 헤더·행·그룹·페이징을 하나도 쓰지 않아(E) 상속하면 쓰지 않는 DOM 이
 * 통째로 따라온다. 대신 **모듈을 계승한다** — 열기(`openTarget`)·값 렌더(`renderValue`)·안내 띠와 오류
 * 줄(`viewShell`)·날짜 문자열(`dateText`)·화면 언어와 첫 요일(`timelineAxis`)이 전부 확정분 그대로다.
 *
 * 그리드의 단위는 **칸이 아니라 주**다. 칸마다 항목을 쌓으면 같은 줄의 높이가 칸마다 따로 정해져
 * 막대가 어긋난다(마스터 1차 16·22번). 줄을 그리드 행으로 두면 높이가 구조적으로 하나가 된다.
 */
export class PlusCalendarView extends BasesView {
	type = PLUS_CALENDAR_VIEW_TYPE;

	private readonly containerEl: HTMLElement;
	private readonly rootEl: HTMLElement;
	private readonly calendarEl: HTMLElement;
	private readonly periodEl: HTMLElement;
	private readonly colorButtonEl: HTMLElement;
	private readonly modeEls = new Map<CalendarMode, HTMLElement>();
	private readonly noticeEl: HTMLElement;
	private readonly weekdaysEl: HTMLElement;
	private readonly gridEl: HTMLElement;
	private readonly errorEl: HTMLElement;
	private readonly weekdayEls: HTMLElement[] = [];
	private readonly weekEls: WeekEl[] = [];

	/** 보고 있는 기간. **저장하지 않는다** — 보는 위치이지 뷰 설정이 아니다(페이지 번호와 같은 판단). */
	private anchor: Date | null = null;
	/**
	 * 펼친 줄들. **여러 줄을 함께 펼칠 수 있다**(마스터 1차 9번 — 앞서 펼친 줄이 접힐 필요는 없다).
	 * 저장하지 않고 기간을 옮기면 풀린다.
	 */
	private readonly expandedWeeks = new Set<number>();

	private readonly taskSource: CalendarTaskSource;
	private taskMap = new Map<string, CalendarTask[]>();
	/** 마지막으로 태스크를 모은 쿼리 결과. 결과가 갈리면 다시 모은다. */
	private taskData: unknown = null;
	private taskRun = 0;

	/** 진행 중인 드래그. 하나뿐이다. */
	private drag: ItemDrag | null = null;
	/**
	 * 끈 제스처가 끝난 시각. 그 직후의 클릭은 열기로 새지 않게 무시한다.
	 *
	 * **스스로 풀리는 값이라야 한다.** 한 번 세우고 클릭에서 내리는 표식으로 두면, 그 클릭이 우리 슬롯이
	 * 아니라 캡처를 쥔 루트로 갈 때 표식이 남아 **다음번 진짜 클릭을 삼킨다**(열기가 조용히 죽는다).
	 */
	private dragEndedAt = 0;
	/** 마지막 갱신에 그린 것들. 미리보기가 값을 다시 읽지 않고 이 배열만 고쳐 다시 배치한다. */
	private lastItems: CalendarItem[] = [];
	private lastPeriod: CalendarPeriod | null = null;
	private lastMode: CalendarMode = 'month';

	/** 클릭·우클릭이 그 항목의 파일을 찾는 통로. 항목은 계산 층이 만들어 파일을 모른다. */
	private readonly entries = new Map<string, BasesEntry>();
	private readonly taskFiles = new Map<string, string>();

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);

		this.containerEl = containerEl;
		this.rootEl = containerEl.createDiv({ cls: 'bases-plus-view is-calendar' });
		this.calendarEl = this.rootEl.createDiv({ cls: 'bases-plus-calendar' });

		// 머리 — 기간 이름과 그것을 바꾸는 컨트롤은 한 묶음이다(확정 1).
		const headEl = this.calendarEl.createDiv({ cls: 'bases-plus-cal-head' });
		// 이름을 누르면 년·월을 고른다(마스터 1차 요청). 누를 수 있는 것이라 버튼 어휘를 쓴다.
		this.periodEl = headEl.createEl('button', {
			cls: 'bases-plus-cal-period',
			attr: { type: 'button', 'aria-label': t('Choose month') },
		});
		this.registerDomEvent(this.periodEl, 'click', () => this.pickPeriod());

		const navEl = headEl.createDiv({ cls: 'bases-plus-cal-nav' });
		this.createNavButton(navEl, 'lucide-chevron-left', t('Previous period'), () => this.step(-1));
		// 문구 버튼은 확정분 `Show all (N)` 과 같은 어휘다 — 같은 성격이라 같은 모습이어야 한다.
		const todayEl = navEl.createEl('button', {
			cls: 'bases-plus-group-more bases-plus-cal-today',
			text: t('Today'),
			attr: { type: 'button' },
		});
		this.registerDomEvent(todayEl, 'click', () => this.goToday());
		this.createNavButton(navEl, 'lucide-chevron-right', t('Next period'), () => this.step(1));

		/*
		 * 색표 진입점 — 공개 뷰 옵션에 버튼 종류가 없어(타임라인이 푸터에 둔 것과 같은 사정) 머리에 둔다.
		 * `Color by` 가 비면 고를 값이 없어 버튼 자체를 감춘다.
		 */
		// 오른쪽 끝 컨트롤은 한 상자에 묶는다 — 팔레트가 감춰져도 세그먼트 자리가 흔들리지 않는다.
		const toolsEl = headEl.createDiv({ cls: 'bases-plus-cal-tools' });
		this.colorButtonEl = toolsEl.createEl('button', {
			cls: 'bases-plus-cal-tool clickable-icon',
			attr: { type: 'button', 'aria-label': t('Item colors') },
		});
		setIcon(this.colorButtonEl, 'lucide-palette');
		this.registerDomEvent(this.colorButtonEl, 'click', (evt) => {
			evt.preventDefault();
			this.openItemColors();
		});

		// 두 개짜리 세그먼트라 드롭다운을 쓰지 않는다(A2).
		const modesEl = toolsEl.createDiv({ cls: 'bases-plus-cal-modes' });
		for (const mode of ['month', 'week'] as CalendarMode[]) {
			const el = modesEl.createEl('button', {
				cls: 'bases-plus-cal-mode',
				text: t(CALENDAR_MODE_CHOICES[mode]),
				attr: { type: 'button' },
			});
			this.registerDomEvent(el, 'click', () => this.setMode(mode));
			this.modeEls.set(mode, el);
		}

		this.noticeEl = createNoticeEl(this.calendarEl);
		this.weekdaysEl = this.calendarEl.createDiv({ cls: 'bases-plus-cal-weekdays' });
		this.gridEl = this.calendarEl.createDiv({ cls: 'bases-plus-cal-grid' });
		this.errorEl = createErrorEl(this.rootEl);

		/*
		 * **드래그의 이동·놓기는 뷰 루트가 받는다.** 손잡이에 걸면 미리보기가 그리드를 다시 배치하는 순간
		 * 그 요소가 부모에 다시 붙어 실물 DOM 이 포인터 캡처를 암묵 해제한다 — 그 뒤로는 이동도 놓기도
		 * 손잡이로 오지 않아 **마우스를 떼도 드래그가 안 끝났다**(4차 4·5번 · 재현으로 확정).
		 * 루트는 갱신에서 다시 붙지 않으므로 캡처가 제스처 내내 살아 있다.
		 */
		this.registerDomEvent(this.rootEl, 'pointermove', (evt) => this.onDragMove(evt));
		this.registerDomEvent(this.rootEl, 'pointerup', (evt) => this.onDragEnd(evt));
		this.registerDomEvent(this.rootEl, 'pointercancel', () => this.cancelDrag());
		// 캡처를 잃으면(창 밖으로 나가거나 다른 창이 가져가면) 끄는 것을 끝낸다 — 갇힌 드래그를 안 만든다.
		this.registerDomEvent(this.rootEl, 'lostpointercapture', () => this.cancelDrag());

		// Tasks 캐시가 갱신되면 다시 모은다 — 우리 화면이 그 플러그인보다 오래된 상태로 남지 않게.
		this.taskSource = new CalendarTaskSource(this.app, () => {
			this.taskData = null;
			this.onDataUpdated();
		});
	}

	onunload(): void {
		if (this.drag) this.finishDrag(false);
		this.taskSource.unload();
		this.rootEl.remove();
		this.weekEls.length = 0;
	}

	onDataUpdated(): void {
		// 네이티브 뷰 3종이 모두 여기서 is-loading 을 뗀다. 빠뜨리면 로딩 표시가 남는다.
		this.containerEl.removeClass('is-loading');

		try {
			this.render();
			this.errorEl.hide();
		} catch (error) {
			console.error('Bases Plus: rendering the calendar failed.', error);
			showViewError(this.errorEl);
		}
	}

	private render(): void {
		const locale = screenLanguage();
		const weekStart = this.getWeekStart(locale);
		const today = atMidnight(new Date());
		const mode = this.getMode();
		/*
		 * 보고 있는 자리는 **기간의 시작이 아니라 그 안의 날짜**다. 그릴 때마다 기간 시작으로 내리면
		 * 월→주 전환이 오늘이 든 주가 아니라 **그 달 1일이 든 주**로 뛰고(8월 10일에서 7월 26일 주가 떴다),
		 * 다시 월로 돌아올 때 지난달이 된다. 기간 경계로 내리는 것은 이동할 때뿐이다(`shiftPeriod`).
		 */
		const period = buildPeriod(this.anchor ?? today, mode, weekStart, today, locale);
		if (this.anchor === null) this.anchor = today;

		const startProperty = this.readProperty(START_DATE_KEY);
		const items = this.collectItems(startProperty, this.readProperty(END_DATE_KEY));

		this.lastItems = items;
		this.lastPeriod = period;
		this.lastMode = mode;

		this.syncHead(period, mode);
		this.syncWeekdays(weekStart, locale);
		this.syncGrid(period, items, mode);
		// 안내는 그리드를 세운 뒤에 정한다 — 임베드에서 잘리는지는 높이를 만들어 봐야 안다(A4).
		syncNoticeEl(this.noticeEl, startProperty === null ? NOTICE_NEEDS_START : this.embedNotice());
		this.ensureTasks();
	}

	// ── 머리 ────────────────────────────────────────────────────────────────────────

	private syncHead(period: CalendarPeriod, mode: CalendarMode): void {
		this.periodEl.setText(period.title);
		// 고를 값이 없는 대화상자를 열 수 없게 한다 — `Color by` 가 비면 요소 자체가 없다(타임라인 J1).
		if (this.readProperty(COLOR_BY_KEY)) this.colorButtonEl.show();
		else this.colorButtonEl.hide();
		this.modeEls.forEach((el, key) => el.toggleClass('is-active', key === mode));
		this.calendarEl.toggleClass('is-week', mode === 'week');
		this.calendarEl.toggleClass('is-wrap', this.config.get(WRAP_KEY) === true);
	}

	private syncWeekdays(weekStart: number, locale: string): void {
		const names = weekdayNames(weekStart, locale);

		while (this.weekdayEls.length < names.length) {
			this.weekdayEls.push(this.weekdaysEl.createDiv({ cls: 'bases-plus-cal-weekday' }));
		}

		this.weekdayEls.forEach((el, index) => el.setText(names[index] ?? ''));
	}

	private step(direction: number): void {
		const weekStart = this.getWeekStart(screenLanguage());

		this.anchor = shiftPeriod(this.anchor ?? new Date(), this.getMode(), direction, weekStart);
		// 보는 위치가 바뀌면 상태도 초기로 — 펼침은 지금 보려는 것이지 설정이 아니다(확정 2).
		this.expandedWeeks.clear();
		this.onDataUpdated();
	}

	private goToday(): void {
		this.anchor = atMidnight(new Date());
		this.expandedWeeks.clear();
		this.onDataUpdated();
	}

	private setMode(mode: CalendarMode): void {
		if (this.getMode() === mode) return;

		this.config.set(MODE_KEY, mode);
		this.expandedWeeks.clear();
		this.onDataUpdated();
	}

	/** 기간 이름을 누르면 년·월을 고른다(마스터 1차 요청). 공개 API 만 쓰는 코어 어휘의 대화상자다. */
	private pickPeriod(): void {
		const at = this.anchor ?? atMidnight(new Date());

		openPeriodPicker({
			app: this.app,
			locale: screenLanguage(),
			current: at,
			onChoose: (date) => {
				this.anchor = date;
				this.expandedWeeks.clear();
				this.onDataUpdated();
			},
		});
	}

	// ── 그리드 ──────────────────────────────────────────────────────────────────────

	private syncGrid(period: CalendarPeriod, items: CalendarItem[], mode: CalendarMode): void {
		// 주 보기는 `+N` 없이 전부 보여 준다(마스터 1차 요청).
		const limit = mode === 'week' ? Number.POSITIVE_INFINITY : this.getItemsPerDay();
		// 줄마다 전체 목록을 훑지 않는다 — 한 번 나눠 담아 두고 자기 줄 몫만 본다(성1).
		const buckets = bucketByWeek(period.weeks, items);
		const properties = this.itemProperties();
		const context = this.slotContext();

		period.weeks.forEach((days, weekIndex) => {
			const weekEl = this.getWeek(weekIndex);

			this.renderWeek(weekEl, layoutWeek(days, buckets[weekIndex] ?? [], limit), weekIndex, limit, properties, context, mode);
			this.gridEl.appendChild(weekEl.el);
		});

		for (let i = period.weeks.length; i < this.weekEls.length; i++) {
			this.weekEls[i].el.hide();
		}
	}

	private renderWeek(
		week: WeekEl,
		layout: ReturnType<typeof layoutWeek>,
		index: number,
		limit: number,
		properties: BasesPropertyId[],
		context: SlotContext,
		mode: CalendarMode
	): void {
		const expanded = this.expandedWeeks.has(index);
		const visibleLanes = expanded ? layout.laneCount : Math.min(layout.laneCount, limit);
		const hasMore = !expanded && layout.hidden.some((count) => count > 0);
		const laneRows = mode === 'week' ? Math.max(WEEK_MIN_LANES, visibleLanes) : visibleLanes + (hasMore ? 1 : 0);

		week.el.show();
		week.index = index;
		week.firstDate = layout.days[0]?.date ?? null;
		week.el.toggleClass('is-expanded', expanded);
		/*
		 * 행을 **명시적으로** 세운다. 배경 칸이 `grid-row: 1 / -1` 로 줄 전체를 덮어야 하는데,
		 * `-1` 은 명시적 그리드의 마지막 선이라 자동 행만 있으면 첫 행에서 끝난다.
		 * 마지막 한 줄은 아래 여백이다 — 컨테이너 padding 으로 주면 배경 칸이 거기까지 안 닿는다.
		 */
		week.el.setCssStyles({
			/*
			 * 마지막 한 줄은 아래 여백이자 **남는 높이를 먹는 자리**다(`minmax(4px, 1fr)`). 고정 4px 로 두면
			 * `min-height` 로 생긴 여유가 어느 행에도 안 들어가 배경 칸이 주 바닥까지 못 닿고 격자색이 비친다.
			 */
			gridTemplateRows: `auto repeat(${Math.max(1, laneRows)}, ${laneTrack(mode)}) minmax(var(--size-2-2), 1fr)`,
		});

		for (let col = 0; col < week.days.length; col++) {
			const day = layout.days[col];

			week.days[col].toggleClass('is-today', !!day?.today);
			week.days[col].toggleClass('is-outside', !!day?.outside);
			week.days[col].toggleClass('is-weekend', !!day?.weekend);

			const head = week.heads[col];
			head.date = day?.date ?? null;
			head.numEl.setText(day ? String(day.date.getDate()) : '');
			// 배경 칸과 날짜 줄은 형제라 CSS 가 서로를 못 본다 — 같은 표식을 양쪽에 붙인다.
			head.el.toggleClass('is-today', !!day?.today);
			head.el.toggleClass('is-outside', !!day?.outside);
		}

		let used = 0;
		for (const placement of layout.placements) {
			if (placement.lane >= visibleLanes) continue;

			const slot = this.getSlot(week, used++);

			this.renderSlot(slot, placement, properties, context, layout.days[0].date);
			week.el.appendChild(slot.el);
		}

		for (let i = used; i < week.slots.length; i++) {
			week.slots[i].item = null;
			week.slots[i].el.hide();
		}

		for (let col = 0; col < week.mores.length; col++) {
			const count = layout.hidden[col] ?? 0;
			const moreEl = week.mores[col];

			if (!hasMore || count === 0) {
				moreEl.hide();
				continue;
			}

			moreEl.show();
			moreEl.setText(`+${count}`);
			moreEl.setCssStyles({ gridColumn: `${col + 1}`, gridRow: `${visibleLanes + 2}` });
		}
	}

	private getWeek(index: number): WeekEl {
		while (this.weekEls.length <= index) this.weekEls.push(this.createWeek(this.weekEls.length));

		this.weekEls[index].el.show();

		return this.weekEls[index];
	}

	private createWeek(index: number): WeekEl {
		const el = this.gridEl.createDiv({ cls: 'bases-plus-cal-week' });
		const week: WeekEl = { el, days: [], heads: [], slots: [], mores: [], index, firstDate: null };

		for (let col = 0; col < 7; col++) {
			const dayEl = el.createDiv({ cls: 'bases-plus-cal-day' });
			dayEl.setCssStyles({ gridColumn: `${col + 1}`, gridRow: '1 / -1' });
			week.days.push(dayEl);
		}

		for (let col = 0; col < 7; col++) {
			const headEl = el.createDiv({ cls: 'bases-plus-cal-dayhead' });
			headEl.setCssStyles({ gridColumn: `${col + 1}`, gridRow: '1' });

			const head: DayHead = {
				el: headEl,
				numEl: headEl.createDiv({ cls: 'bases-plus-cal-daynum' }),
				addEl: headEl.createEl('button', {
					cls: 'bases-plus-cal-add',
					attr: { type: 'button', 'aria-label': t('New item on this day') },
				}),
				date: null,
			};
			setIcon(head.addEl, 'lucide-plus');
			// 항목이 있든 없든 **같은 자리**에 선다 — 빈 칸에만 있으면 바쁜 날에 손이 갈 곳이 없다(1차 19번).
			this.registerDomEvent(head.addEl, 'click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				if (head.date) void this.addItem(head.date);
			});

			week.heads.push(head);
		}

		for (let col = 0; col < 7; col++) {
			const moreEl = el.createEl('button', { cls: 'bases-plus-cal-more', attr: { type: 'button' } });
			moreEl.hide();
			// 펼치면 되접는 단추를 두지 않는다 — 초기화는 기간 이동으로 충분하다(마스터 1차 8번).
			this.registerDomEvent(moreEl, 'click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.expandedWeeks.add(week.index);
				this.onDataUpdated();
			});
			week.mores.push(moreEl);
		}

		return week;
	}

	private getSlot(week: WeekEl, index: number): SlotEl {
		while (week.slots.length <= index) week.slots.push(this.createSlot(week));

		return week.slots[index];
	}

	private createSlot(week: WeekEl): SlotEl {
		const el = week.el.createDiv({ cls: 'bases-plus-cal-slot' });
		const itemEl = el.createDiv({ cls: 'bases-plus-cal-item' });
		const headEl = itemEl.createDiv({ cls: 'bases-plus-cal-item-head' });
		const taskEl = el.createDiv({ cls: 'bases-plus-cal-task' });
		const slot: SlotEl = {
			el,
			itemEl,
			headEl,
			checkEl: headEl.createEl('button', {
				cls: 'bases-plus-cal-check-box',
				attr: { type: 'button', 'aria-label': t('Toggle checkbox') },
			}),
			itemTextEl: headEl.createSpan({ cls: 'bases-plus-cal-item-text' }),
			pillEl: headEl.createEl('button', {
				cls: 'bases-plus-cal-item-pill',
				attr: { type: 'button', 'aria-label': t('Change value') },
			}),
			propsEl: itemEl.createDiv({ cls: 'bases-plus-cal-item-props' }),
			propRows: [],
			startHandleEl: itemEl.createDiv({ cls: 'bases-plus-cal-handle mod-start' }),
			endHandleEl: itemEl.createDiv({ cls: 'bases-plus-cal-handle mod-end' }),
			taskEl,
			markEl: taskEl.createSpan({ cls: 'bases-plus-cal-check' }),
			taskTextEl: taskEl.createSpan({ cls: 'bases-plus-cal-task-text' }),
			item: null,
			placement: null,
			weekStart: null,
		};

		taskEl.hide();
		slot.checkEl.hide();
		slot.pillEl.hide();
		slot.propsEl.hide();
		slot.startHandleEl.hide();
		slot.endHandleEl.hide();

		this.bindHandle(slot, slot.startHandleEl, 'start');
		this.bindHandle(slot, slot.endHandleEl, 'end');

		// 리스너는 요소를 만들 때 한 번만 건다. 갱신마다 걸면 등록이 누적된다(성2).
		this.registerDomEvent(el, 'click', (evt) => {
			// 끈 직후의 클릭은 삼킨다 — 끌어 놓고 노트가 열리면 안 된다.
			if (Date.now() - this.dragEndedAt < CLICK_AFTER_DRAG_MS) return;

			const file = this.fileOf(slot.item);
			if (!file) return;
			// 수식어·보조 버튼 클릭은 코어 링크 동작에 그대로 넘긴다.
			if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

			evt.preventDefault();
			evt.stopPropagation();
			void openTarget(this.app, file, this.getOpenMode());
		});
		this.registerDomEvent(el, 'contextmenu', (evt) => {
			const file = this.fileOf(slot.item);
			if (evt.defaultPrevented || !file) return;

			evt.preventDefault();
			const menu = new Menu();
			addOpenItem(menu, this.app, file, this.getOpenMode());
			menu.showAtMouseEvent(evt);
		});
		/*
		 * 호버하면 **같은 항목의 조각이 전부** 물든다(마스터 1차 요청 — "그 대상이 어떤 건지 나타낼 수
		 * 있도록"). 한 주 안에서는 막대가 한 요소지만 주를 넘으면 주마다 조각이 하나씩 생긴다.
		 */
		this.registerDomEvent(el, 'pointerenter', () => this.highlight(slot.item?.id ?? null));
		this.registerDomEvent(el, 'pointerleave', () => this.highlight(null));

		this.registerDomEvent(slot.checkEl, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			void this.toggleCheck(slot.item);
		});
		this.registerDomEvent(slot.pillEl, 'click', (evt) => {
			const property = this.readProperty(LIST_KEY);
			const entry = slot.item ? this.entries.get(slot.item.id) : null;
			if (!property || !entry) return;

			evt.preventDefault();
			evt.stopPropagation();
			this.openValueMenu(entry, property, evt);
		});

		return slot;
	}

	/**
	 * 손잡이는 **누르기만** 받는다. 끄는 동안의 이동·놓기는 뷰 루트가 받는다 —
	 * 미리보기가 그리드를 다시 배치하면 이 요소는 부모에 다시 붙고, 그 순간 실물 DOM 이
	 * 포인터 캡처를 암묵 해제해 여기로는 아무 이벤트도 오지 않는다(4차 4·5번의 원인).
	 */
	private bindHandle(slot: SlotEl, el: HTMLElement, kind: ItemDrag['kind']): void {
		this.registerDomEvent(el, 'pointerdown', (evt) => this.onDragStart(slot, kind, evt));
		// 끈 뒤에도 클릭이 뒤따른다 — 손잡이 위 클릭이 열기로 새지 않게 여기서 끊는다.
		this.registerDomEvent(el, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
		});
	}

	private renderSlot(
		slot: SlotEl,
		placement: CalendarPlacement,
		properties: BasesPropertyId[],
		context: SlotContext,
		weekStart: Date
	): void {
		const { item } = placement;

		slot.item = item;
		slot.placement = placement;
		slot.weekStart = weekStart;
		slot.el.show();
		slot.el.setAttr('data-item', item.id);
		// 줄이 곧 행이다 — 걸친 칸을 가로지르는 한 요소라 칸 경계에서 끊기지 않는다(1차 16번).
		slot.el.setCssStyles({
			gridColumn: `${placement.from + 1} / ${placement.to + 2}`,
			gridRow: `${placement.lane + 2}`,
		});

		if (item.kind === 'task') {
			slot.itemEl.hide();
			slot.taskEl.show();
			slot.markEl.setText(TASK_GLYPHS[item.status ?? 'todo'] ?? TASK_GLYPHS.todo);
			slot.taskTextEl.setText(item.label);
			slot.taskEl.toggleClass('is-done', item.status === 'done');
			slot.taskEl.toggleClass('is-cancelled', item.status === 'cancelled');
			return;
		}

		slot.taskEl.hide();
		slot.itemEl.show();
		slot.itemTextEl.setText(item.label);
		slot.itemEl.toggleClass('is-clipped-start', placement.clippedStart);
		slot.itemEl.toggleClass('is-clipped-end', placement.clippedEnd);

		const entry = this.entries.get(item.id) ?? null;

		this.paintItem(slot, entry, context);
		this.renderHandles(slot, placement);
		this.renderCheckbox(slot, entry, context);
		this.renderPill(slot, entry, context);
		this.renderProperties(slot, entry, properties, context);
	}

	/**
	 * 칩 색 — **타임라인 막대의 산식 그대로다**(확정 8-1: 옅은 채움 + 왼쪽 3px 띠).
	 * `Color by` 를 안 정하면 색이 없다 — 마스터 2차 8번("기본값도 배경색이 거의 없었으면")대로
	 * 아주 옅은 바탕만 남기고 글자는 본문색이다.
	 */
	private paintItem(slot: SlotEl, entry: BasesEntry | null, context: SlotContext): void {
		const slotIndex =
			entry && context.colorProperty
				? barColorFor(entry, context.colorProperty, context.colorOrder, context.colors)
				: null;

		slot.itemEl.toggleClass('is-tinted', slotIndex !== null);
		slot.itemEl.setCssProps({ '--bases-plus-cal-color': slotIndex === null ? '' : `var(--bases-plus-series-${slotIndex})` });
		// 띠는 **막대가 실제로 시작하는 조각에만** 선다 — 주 경계에서 잘린 쪽은 그 기간의 시작이 아니다.
		slot.itemEl.toggleClass('is-band', slotIndex !== null && !slot.itemEl.hasClass('is-clipped-start'));
	}

	/**
	 * 끝단 손잡이 — **실제 시작·끝 조각에만** 둔다(2차 요청). 주 경계에서 잘린 쪽에 손잡이를 두면
	 * 그 조각의 끝을 기간의 끝으로 착각하게 된다. 종료 속성을 안 정했으면 끝을 쓸 자리가 없어 감춘다.
	 */
	private renderHandles(slot: SlotEl, placement: CalendarPlacement): void {
		const draggable = placement.item.kind === 'file' && this.readProperty(START_DATE_KEY) !== null;
		const hasEnd = this.readProperty(END_DATE_KEY) !== null;

		if (draggable && !placement.clippedStart) slot.startHandleEl.show();
		else slot.startHandleEl.hide();

		if (draggable && hasEnd && !placement.clippedEnd) slot.endHandleEl.show();
		else slot.endHandleEl.hide();
	}

	/**
	 * 속성은 칩 안에 목록으로 선다(1차 22번 수정 · 2차 10번 UI 조정).
	 *
	 * 이름과 값은 **두 열 그리드**라 줄마다 값이 같은 x 에서 시작한다 — 이름 길이가 제각각이라
	 * 흐름 배치로는 정렬이 안 맞는다(마스터 캡처의 지적). 이름을 감추면 값만 남는다(`Values only`).
	 */
	private renderProperties(
		slot: SlotEl,
		entry: BasesEntry | null,
		properties: BasesPropertyId[],
		context: SlotContext
	): void {
		if (!entry || properties.length === 0) {
			slot.propsEl.hide();
			this.clearRows(slot, 0);
			return;
		}

		let used = 0;

		for (const property of properties) {
			const text = readEditableValue(entry, property);
			// 빈 값 줄은 기본으로 접는다 — 켜면 자리를 지켜 어떤 속성이 비었는지가 보인다(2차 10번).
			if (text === '' && !context.showEmpty) continue;

			const row = this.getRow(slot, used++);

			row.property = property;
			row.entry = entry;
			row.kind = this.inlineKind(property, entry, text);
			row.el.show();
			row.el.toggleClass('is-editable', row.kind !== null);

			if (context.namesShown) {
				row.nameEl.show();
				row.nameEl.setText(this.config.getDisplayName(property));
			} else {
				row.nameEl.hide();
			}

			row.valueEl.empty();
			/*
			 * 두 타입만 **직접 그린다.**
			 * ① 체크박스 — 코어 렌더러의 `input` 이 이 자리에서 16×0 으로 찌그러지거나 열 폭만큼 늘어난
			 *    저대비 상자가 된다(3차 4번 ⓒ·8번 실측). 제목 앞 체크박스와 같은 글리프로 통일한다.
			 * ② 날짜 — 분절 입력칸이라 폭이 111px 에서 줄지 않는데 값 자리는 53px 까지 좁아져 잘린다.
			 * 나머지 타입은 확정분대로 `renderTo` 를 태운다(링크·태그는 좁은 자리에서도 온전하다).
			 */
			row.checkEl = row.valueEl.createSpan({ cls: 'bases-plus-cal-prop-check' });
			if (row.kind === 'checkbox') {
				row.checkEl.show();
				row.checkEl.setText(text === 'true' ? TASK_GLYPHS.done : TASK_GLYPHS.todo);
				row.checkEl.toggleClass('is-checked', text === 'true');
			} else {
				row.checkEl.hide();

				if (text !== '' && (row.kind === 'date' || row.kind === 'datetime')) row.valueEl.createSpan({ cls: 'bases-plus-cal-prop-text', text });
				else if (text !== '') renderValue(this.app, entry, property, row.valueEl);
				// 빈 값은 그릴 것이 없어 자리가 사라진다 — 줄을 세우기로 했으면 자리는 남겨야 한다.
				else row.valueEl.createSpan({ cls: 'bases-plus-cal-prop-empty', text: '—' });
			}

			/*
			 * 이름을 감춘 방식에서는 **어떤 속성인지 툴팁이 답한다**(3차 6번의 모호함 처리).
			 * 빈 값이면 `—` 만 남아 더욱 그렇다 — 값 위에 속성 이름을 달아 둔다.
			 */
			if (context.namesShown) row.valueEl.removeAttribute('aria-label');
			else row.valueEl.setAttr('aria-label', this.config.getDisplayName(property));
		}

		slot.propsEl.toggleClass('is-values-only', !context.namesShown);
		if (used === 0) slot.propsEl.hide();
		else slot.propsEl.show();

		this.clearRows(slot, used);
	}

	/** 칩 안에서 바로 고칠 수 있는 타입인지 — 목록형·날짜·체크박스만이다(2차 10번). */
	private inlineKind(property: BasesPropertyId, entry: BasesEntry, current: string): EditableKind | null {
		if (!String(property).startsWith('note.')) return null;

		const kind = resolveEditableKind(this.app, property, valueTypeOf(entry, property), current);

		return INLINE_EDITABLE.indexOf(kind) === -1 ? null : kind;
	}

	private clearRows(slot: SlotEl, from: number): void {
		for (let i = from; i < slot.propRows.length; i++) {
			slot.propRows[i].property = null;
			slot.propRows[i].entry = null;
			slot.propRows[i].el.hide();
		}
	}

	private getRow(slot: SlotEl, index: number): PropRow {
		while (slot.propRows.length <= index) slot.propRows.push(this.createRow(slot));

		return slot.propRows[index];
	}

	private createRow(slot: SlotEl): PropRow {
		const el = slot.propsEl.createDiv({ cls: 'bases-plus-cal-item-prop' });
		// **이름을 먼저 만든다** — 그리드 열은 DOM 순서가 정하므로 값이 앞서면 두 칸이 뒤바뀐다.
		const nameEl = el.createSpan({ cls: 'bases-plus-cal-prop-name' });
		const valueEl = el.createSpan({ cls: 'bases-plus-cal-prop-value bases-rendered-value' });
		const row: PropRow = {
			el,
			nameEl,
			valueEl,
			checkEl: valueEl.createSpan({ cls: 'bases-plus-cal-prop-check' }),
			property: null,
			entry: null,
			kind: null,
		};

		row.checkEl.hide();

		// 값 클릭은 **수정**이지 열기가 아니다 — 칩 클릭(열기)으로 새지 않게 여기서 끊는다.
		this.registerDomEvent(row.valueEl, 'click', (evt) => {
			if (!row.property || !row.entry || row.kind === null) return;

			evt.preventDefault();
			evt.stopPropagation();
			this.editProperty(row, evt);
		});

		return row;
	}

	/** 쓰기는 **표 셀 편집과 같은 공개 경로**다 — 같은 값이 뷰마다 다르게 저장되면 안 된다. */
	private editProperty(row: PropRow, evt: MouseEvent): void {
		const { property, entry, kind } = row;
		const file = entry?.file;
		if (!property || !entry || !file || kind === null) return;

		const current = readEditableValue(entry, property);

		if (kind === 'checkbox') {
			void toggleCheckbox(this.app, file, property, current === 'true').then(() => this.onDataUpdated());
			return;
		}

		if (kind === 'list') {
			this.openValueMenu(entry, property, evt);
			return;
		}

		row.valueEl.empty();
		beginCellEdit({
			app: this.app,
			file,
			property,
			kind,
			el: row.valueEl,
			current,
			entry,
			onDone: () => this.onDataUpdated(),
		});
	}

	/** 제목 앞 체크박스 — 누르면 그 자리에서 뒤집는다(표의 체크박스 셀과 같은 쓰기 경로). */
	private renderCheckbox(slot: SlotEl, entry: BasesEntry | null, context: SlotContext): void {
		if (!entry || !context.checkbox) {
			slot.checkEl.hide();
			return;
		}

		const raw = readEditableValue(entry, context.checkbox);
		/*
		 * **속성이 없는 노트에는 기본으로 안 세운다**(2차 11번 하위). 없는 속성 자리에 컨트롤을 두면
		 * 눌렀을 때 그 노트에 없던 키가 생긴다 — 켜는 옵션은 두되 기본은 안 만드는 쪽이다.
		 */
		if (raw === '' && !context.checkboxWhenMissing) {
			slot.checkEl.hide();
			return;
		}

		const checked = raw === 'true';

		slot.checkEl.show();
		slot.checkEl.setText(checked ? TASK_GLYPHS.done : TASK_GLYPHS.todo);
		slot.checkEl.toggleClass('is-checked', checked);
	}

	/** 목록 속성 값 — 누르면 그 base 에 실제로 있는 값들이 메뉴로 뜬다. */
	private renderPill(slot: SlotEl, entry: BasesEntry | null, context: SlotContext): void {
		if (!entry || !context.list) {
			slot.pillEl.hide();
			return;
		}

		const text = readEditableValue(entry, context.list);

		slot.pillEl.show();
		slot.pillEl.setText(text === '' ? '—' : text);
	}

	/**
	 * 이번 갱신에 슬롯마다 필요한 값들. 슬롯 안에서 매번 config 를 읽으면 같은 답을 수백 번 구한다(성1).
	 */
	private slotContext(): SlotContext {
		const colorProperty = this.readProperty(COLOR_BY_KEY);
		const order = colorProperty ? collectValues(this.data?.data ?? [], colorProperty, Array.from(readBarColors(this.config).keys())) : [];

		return {
			checkbox: this.readProperty(CHECKBOX_KEY),
			checkboxWhenMissing: this.config.get(CHECKBOX_MISSING_KEY) === true,
			list: this.readProperty(LIST_KEY),
			colorProperty,
			colorOrder: order,
			colors: colorProperty ? resolveBarColors(order, readBarColors(this.config)) : new Map<string, number>(),
			namesShown: this.config.get(PROPERTY_DISPLAY_KEY) !== 'values',
			showEmpty: this.config.get(SHOW_EMPTY_KEY) === true,
		};
	}

	/**
	 * 색표 대화상자 — **타임라인의 그것을 그대로 연다**(같은 모듈·같은 저장 키). 두 뷰가 같은 base 에서
	 * 같은 값에 다른 색을 주면 안 된다.
	 */
	private openItemColors(): void {
		const property = this.readProperty(COLOR_BY_KEY);
		if (!property) return;

		openBarColorModal({
			app: this.app,
			title: this.config.getDisplayName(property),
			values: collectValues(this.data?.data ?? [], property, Array.from(readBarColors(this.config).keys())),
			colors: readBarColors(this.config),
			onChange: (colors) => {
				saveBarColors(this.config, colors);
				this.onDataUpdated();
			},
		});
	}

	private highlight(id: string | null): void {
		for (const week of this.weekEls) {
			for (const slot of week.slots) {
				slot.el.toggleClass('is-hovered', id !== null && slot.item?.id === id);
			}
		}
	}

	private async toggleCheck(item: CalendarItem | null): Promise<void> {
		const property = this.readProperty(CHECKBOX_KEY);
		const entry = item ? this.entries.get(item.id) : null;
		if (!property || !entry?.file) return;

		await toggleCheckbox(this.app, entry.file, property, readEditableValue(entry, property) === 'true');
		this.onDataUpdated();
	}

	/** 목록형 값 고르기 — 칩의 알약과 속성 줄이 **같은 메뉴**를 쓴다. */
	private openValueMenu(entry: BasesEntry, property: BasesPropertyId, evt: MouseEvent): void {
		const file = entry.file;
		if (!file) return;

		const current = readEditableValue(entry, property);
		const values = collectValues(this.data?.data ?? [], property, []);
		const menu = new Menu();
		// 목록 타입이면 배열로 써야 프론트매터가 네이티브와 같은 모양이 된다(항목 추가와 같은 판단).
		const asList = isListProperty(this.app, property);

		for (const value of values) {
			menu.addItem((menuItem) =>
				menuItem
					.setTitle(value)
					.setChecked(value === current)
					.onClick(() => {
						void writeValue(this.app, file, property, asList ? [value] : value).then(() =>
							this.onDataUpdated()
						);
					})
			);
		}

		if (values.length === 0) menu.addItem((menuItem) => menuItem.setTitle(t('No values yet')).setDisabled(true));

		menu.showAtMouseEvent(evt);
	}

	// ── 드래그 (2·3차 요청 — 타임라인 계약 그대로) ─────────────────────────────────

	/**
	 * 포인터가 선 칸의 날짜. **가로 거리만 세지 않는다** — 주가 바뀌는 세로 이동을 그렇게는 못 읽어
	 * 위 줄의 날짜로 못 올라갔다(3차 11번 ⓑ). 어느 주 위에 있는지부터 찾고 그 안에서 칸을 센다.
	 */
	private dayAt(clientX: number, clientY: number): Date | null {
		for (const week of this.weekEls) {
			if (week.el.hidden || !week.firstDate) continue;

			const box = rectOf(week.el);
			if (!box || box.width <= 0) continue;
			if (clientY < box.top || clientY > box.bottom) continue;

			// 칸 폭은 **주 폭을 일곱으로 나눈 값**이다 — 격자선(gap)까지 포함해 경계가 어긋나지 않는다.
			const column = Math.floor((clientX - box.left) / (box.width / 7));

			return shiftDays(week.firstDate, Math.min(6, Math.max(0, column)));
		}

		return null;
	}

	private slotFor(itemId: string): SlotEl | null {
		for (const week of this.weekEls) {
			for (const slot of week.slots) {
				if (!slot.el.hidden && slot.item?.id === itemId) return slot;
			}
		}

		return null;
	}

	private onDragStart(slot: SlotEl, kind: ItemDrag['kind'], evt: PointerEvent): void {
		const item = slot.item;
		if (evt.button !== 0 || this.drag || !item || item.kind !== 'file') return;
		if (this.readProperty(START_DATE_KEY) === null) return;
		// 끝을 고치려면 쓸 자리가 있어야 한다 — 종료 속성이 없으면 통째 이동만 남는다(타임라인 C3).
		if (kind === 'end' && this.readProperty(END_DATE_KEY) === null) return;

		evt.preventDefault();
		evt.stopPropagation();

		this.drag = {
			itemId: item.id,
			kind,
			pointerId: evt.pointerId,
			fromStart: item.start,
			fromEnd: item.end,
			moved: false,
			detachKeys: this.watchEscape(),
		};

		slot.itemEl.addClass('is-dragging');
		// 캡처는 **루트**가 쥔다 — 손잡이는 재배치에 다시 붙어 캡처를 잃는다(위 생성자 주석).
		capturePointer(this.rootEl, evt.pointerId);
	}

	private onDragMove(evt: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.pointerId !== evt.pointerId) return;

		const next = this.nextDates(drag, evt.clientX, evt.clientY);
		if (!next) return;

		// 칩을 누르면 그 노트가 열리므로 드래그와 구분해야 한다 — 날짜가 실제로 바뀔 때부터 드래그다(확정 5).
		if (!drag.moved && next.start.getTime() === drag.fromStart.getTime() && next.end.getTime() === drag.fromEnd.getTime()) {
			return;
		}

		evt.preventDefault();
		drag.moved = true;
		this.preview(drag, next);
	}

	private onDragEnd(evt: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.pointerId !== evt.pointerId) return;

		const next = drag.moved ? this.nextDates(drag, evt.clientX, evt.clientY) : null;

		this.finishDrag(drag.moved);
		if (!next) return;

		void this.writeDates(drag, next);
	}

	/**
	 * 끈 결과의 날짜. 포인터가 선 칸이 곧 목표 날짜다 — 주를 넘어도 같은 규칙이라 위 줄로 올라간다.
	 * 뒤집힌 기간은 만들지 않는다(끝을 시작 앞으로 끌면 시작에서 멈춘다).
	 */
	private nextDates(drag: ItemDrag, clientX: number, clientY: number): { start: Date; end: Date } | null {
		const target = this.dayAt(clientX, clientY);
		if (!target) return null;

		if (drag.kind === 'start') {
			return { start: target > drag.fromEnd ? drag.fromEnd : target, end: drag.fromEnd };
		}

		return { start: drag.fromStart, end: target < drag.fromStart ? drag.fromStart : target };
	}

	/**
	 * 끄는 동안 화면을 **끝난 뒤와 같은 모습**으로 만든다. 끌던 칩만 옮기면 옆 항목 위에 겹쳐 그려져
	 * 이웃이 함께 바뀐 것처럼 보였다(3차 11번 ⓐ 실측: 미리보기 `2 / 8` 이 이웃 `5 / 7` 을 덮었다).
	 * 값은 다시 읽지 않고 **이번에 그린 항목 배열만 고쳐** 다시 배치한다(성1).
	 */
	private preview(drag: ItemDrag, next: { start: Date; end: Date }): void {
		const period = this.lastPeriod;
		if (!period) return;

		const item = this.lastItems.find((candidate) => candidate.id === drag.itemId);
		if (!item) return;

		item.start = next.start;
		item.end = next.end;

		try {
			this.syncGrid(period, this.lastItems, this.lastMode);
		} catch (error) {
			console.error('Bases Plus: previewing the drag failed.', error);
			return;
		}

		// 다시 배치하면 슬롯이 다른 항목을 맡을 수 있다 — 끌고 있는 항목의 지금 슬롯을 다시 찾는다.
		this.slotFor(drag.itemId)?.itemEl.addClass('is-dragging');
	}

	private async writeDates(drag: ItemDrag, next: { start: Date; end: Date }): Promise<void> {
		const startProperty = this.readProperty(START_DATE_KEY);
		const endProperty = this.readProperty(END_DATE_KEY);
		const entry = this.entries.get(drag.itemId);
		const file = entry?.file;
		if (!file || !entry || !startProperty) return;

		if (next.start.getTime() !== drag.fromStart.getTime()) {
			await writeValue(this.app, file, startProperty, formatLikeText(readEditableValue(entry, startProperty), next.start));
		}

		// 원래 종료가 없던 항목도 끝을 끌면 **기간이 된다** — 그때 종료가 새로 생긴다.
		if (endProperty && next.end.getTime() !== drag.fromEnd.getTime()) {
			await writeValue(this.app, file, endProperty, formatLikeText(readEditableValue(entry, endProperty), next.end));
		}

		this.onDataUpdated();
	}

	/** Escape·pointercancel — 원위치로 두고 저장하지 않는다(C3). */
	private cancelDrag(): void {
		const drag = this.drag;
		if (!drag) return;

		const item = this.lastItems.find((candidate) => candidate.id === drag.itemId);
		if (item) {
			item.start = drag.fromStart;
			item.end = drag.fromEnd;
		}

		this.finishDrag(false);
		this.onDataUpdated();
	}

	private finishDrag(moved: boolean): void {
		const drag = this.drag;
		if (!drag) return;

		this.drag = null;
		drag.detachKeys();
		releasePointer(this.rootEl, drag.pointerId);
		// 끈 제스처 뒤에는 클릭이 따라온다 — 그 직후를 삼켜 노트가 열리지 않게 한다.
		if (moved) this.dragEndedAt = Date.now();
		this.slotFor(drag.itemId)?.itemEl.removeClass('is-dragging');
	}

	private watchEscape(): () => void {
		const doc = this.rootEl.ownerDocument as EscapeKeyHost | undefined;
		if (!doc || typeof doc.addEventListener !== 'function') return () => {};

		const onKey = (evt: KeyboardEvent): void => {
			if (evt.key !== 'Escape') return;

			evt.preventDefault();
			this.cancelDrag();
		};

		doc.addEventListener('keydown', onKey, true);

		return () => {
			if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKey, true);
		};
	}

	// ── 항목 ────────────────────────────────────────────────────────────────────────

	/**
	 * 쿼리 행에서 항목을 만든다. **날짜가 없는 항목은 달력에 안 나오고 안내 띠도 띄우지 않는다** —
	 * 정상 상태다(C1).
	 */
	private collectItems(
		startProperty: BasesPropertyId | null,
		endProperty: BasesPropertyId | null
	): CalendarItem[] {
		this.entries.clear();
		this.taskFiles.clear();

		const out: CalendarItem[] = [];
		if (startProperty === null) return out;

		const entries = this.data?.data ?? [];

		entries.forEach((entry, index) => {
			const start = entryDate(entry, startProperty);
			const file = entry.file;
			if (!start || !file) return;

			const end = entryDate(entry, endProperty);

			this.entries.set(file.path, entry);
			out.push({
				id: file.path,
				kind: 'file',
				start,
				end: end && end >= start ? end : start,
				label: file.basename,
				status: null,
				index,
			});
		});

		if (!this.showTasks()) return out;

		let taskIndex = 0;
		this.taskMap.forEach((tasks, path) => {
			for (const task of tasks) {
				const id = `${path}#${task.line}`;

				this.taskFiles.set(id, path);
				// 태스크는 **자기 기한 칸**에 선다 — 파일이 놓인 칸이 아니다(마스터 확정 2026-08-06).
				out.push({
					id,
					kind: 'task',
					start: task.due,
					end: task.due,
					label: task.text,
					status: task.status,
					index: taskIndex++,
				});
			}
		});

		return out;
	}

	/**
	 * 칩 안에 그릴 속성. 이름은 칩이 이미 말하고 있어 뺀다.
	 */
	private itemProperties(): BasesPropertyId[] {
		const properties = this.data?.properties ?? [];

		return properties.filter((property) => property !== 'file.name');
	}

	private fileOf(item: CalendarItem | null): TFile | null {
		if (!item) return null;

		const path = item.kind === 'task' ? this.taskFiles.get(item.id) ?? null : item.id;
		if (path === null) return null;

		return this.entries.get(path)?.file ?? null;
	}

	/**
	 * 그 날짜로 항목을 만든다 — 그 날짜를 **시작 속성에 심는다**(C4). 종료까지 만들지 않는 것은 타임라인의
	 * 빈 트랙 클릭과 같은 판단이다: 사용자가 말하지 않은 값을 만들지 않는다.
	 */
	private async addItem(date: Date): Promise<void> {
		const property = this.readProperty(START_DATE_KEY);
		if (!property || !String(property).startsWith('note.')) return;

		const name = String(property).slice(String(property).indexOf('.') + 1);

		try {
			await this.createFileForView(undefined, (frontmatter: Record<string, unknown>) => {
				frontmatter[name] = formatDateText(date);
			});
		} catch (error) {
			console.error('Bases Plus: creating the item failed.', error);
		}
	}

	// ── 태스크 (선수집 후 렌더 2단) ─────────────────────────────────────────────────

	/**
	 * 본문 읽기가 비동기라 **렌더 안에서 기다리지 않는다**(함정 C). 첫 화면은 파일 칩만 그리고,
	 * 태스크가 모이면 다시 그린다 — "태스크 없음"을 보여주지 않는다. 아직 모르는 것을 없다고 말하면 거짓이다.
	 */
	private ensureTasks(): void {
		if (!this.showTasks()) {
			this.taskData = null;
			if (this.taskMap.size > 0) this.taskMap = new Map();
			return;
		}

		if (this.taskData === this.data) return;

		this.taskData = this.data;
		void this.loadTasks();
	}

	private async loadTasks(): Promise<void> {
		const run = ++this.taskRun;
		const files: TFile[] = [];

		for (const entry of this.data?.data ?? []) {
			if (entry.file) files.push(entry.file);
		}

		try {
			const tasks = await this.taskSource.collect(files);
			// 늦게 온 결과가 새 결과를 덮지 않게 한다 — 갱신이 겹치면 순서가 뒤집힌다(함정 C).
			if (run !== this.taskRun) return;

			this.taskMap = tasks;
			this.onDataUpdated();
		} catch (error) {
			console.error('Bases Plus: collecting tasks failed.', error);
		}
	}

	// ── 뷰 옵션 읽기 ────────────────────────────────────────────────────────────────

	private getMode(): CalendarMode {
		return this.config.get(MODE_KEY) === 'week' ? 'week' : 'month';
	}

	private getItemsPerDay(): number {
		const stored = Number(this.config.get(ITEMS_PER_DAY_KEY));

		return Number.isFinite(stored) && stored >= 1 ? Math.floor(stored) : DEFAULT_ITEMS_PER_DAY;
	}

	/**
	 * 첫 요일. **옵시디언에는 이 설정이 없어** 화면 언어에서 파생된 값이 기본이고(한국어=일요일),
	 * 뷰 옵션이 그 위를 덮는다(디자인 B3).
	 */
	private getWeekStart(locale: string): number {
		const stored = this.config.get(WEEK_START_KEY);
		const value = Number(stored);

		return stored !== undefined && stored !== null && (value === 0 || value === 1)
			? value
			: weekStartFor(locale);
	}

	private showTasks(): boolean {
		return this.config.get(SHOW_TASKS_KEY) === true;
	}

	private getOpenMode(): OpenMode {
		return resolveOpenMode(this.config.get(OPEN_MODE_KEY));
	}

	private readProperty(key: string): BasesPropertyId | null {
		try {
			return this.config.getAsPropertyId(key);
		} catch {
			const raw = this.config.get(key);

			return typeof raw === 'string' && raw !== '' ? (raw as BasesPropertyId) : null;
		}
	}

	/**
	 * 임베드에서 잘리는지. **스스로 높이를 만드는 것이 처방이고 이 띠는 그래도 잘릴 때의 두 번째 처방**이다
	 * (A4). 사용자가 `--bases-embed-height` 를 낮게 준 경우에만 선다 — 기본은 auto 라 잘리지 않는다.
	 */
	private embedNotice(): string | null {
		const host = closest(this.containerEl, '.bases-embed');
		if (!host) return null;

		const available = numberOf(host, 'clientHeight');
		const needed = numberOf(this.rootEl, 'scrollHeight');

		return available > 0 && needed > available + 1 ? NOTICE_EMBED_TALLER : null;
	}

	private createNavButton(parentEl: HTMLElement, icon: string, label: string, onClick: () => void): void {
		// 이동 버튼은 **표 확정분의 페이저 버튼 그대로**다 — 자리만 푸터에서 머리로 옮긴다(확정 1).
		const el = parentEl.createEl('button', {
			cls: 'bases-plus-pager-button',
			attr: { type: 'button', 'aria-label': label },
		});
		setIcon(el, icon);
		this.registerDomEvent(el, 'click', (evt) => {
			evt.preventDefault();
			onClick();
		});
	}
}

/** 이번 갱신에 슬롯마다 쓰는 값들 — 색·조작 속성·속성 줄 표시 방식. */
interface SlotContext {
	checkbox: BasesPropertyId | null;
	/** 속성이 **없는 노트**에도 체크박스를 세울지(2차 11번 하위). */
	checkboxWhenMissing: boolean;
	list: BasesPropertyId | null;
	colorProperty: BasesPropertyId | null;
	colorOrder: string[];
	colors: Map<string, number>;
	namesShown: boolean;
	showEmpty: boolean;
}

/**
 * 줄 하나의 높이. 월 보기는 내용만큼(`min-content`)이고, **주 보기는 최소 한 줄 높이를 보장**한다 —
 * 빈 줄이라도 자리를 잡아야 최소 7줄이 선다(마스터 1차 요청).
 */
function laneTrack(mode: CalendarMode): string {
	return mode === 'week' ? 'minmax(var(--bases-plus-cal-item-height), min-content)' : 'min-content';
}

/**
 * Escape 를 받으려고 문서에서 쓰는 최소 표면. **하네스 요소에는 `ownerDocument` 가 없어** 능력으로 확인하고,
 * `Function` 대신 실제 시그니처를 적어 등록·해제 호출까지 타입이 산다.
 */
type EscapeKeyHost = {
	addEventListener?: (type: 'keydown', listener: (evt: KeyboardEvent) => void, capture: boolean) => void;
	removeEventListener?: (type: 'keydown', listener: (evt: KeyboardEvent) => void, capture: boolean) => void;
};

/** 레이아웃이 없는 하네스에서는 전부 0 이라 드래그가 아무 일도 하지 않는다 — 실물에서만 값이 선다. */
function rectOf(el: HTMLElement | undefined): { top: number; bottom: number; left: number; width: number } | null {
	const measurable = el as { getBoundingClientRect?: () => DOMRect } | undefined;
	if (typeof measurable?.getBoundingClientRect !== 'function') return null;

	const box = measurable.getBoundingClientRect();

	return { top: box.top, bottom: box.bottom, left: box.left, width: box.width };
}

function shiftDays(date: Date, steps: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + steps);
}

function capturePointer(el: HTMLElement | undefined, pointerId: number): void {
	const target = el as { setPointerCapture?(id: number): void } | undefined;
	if (typeof target?.setPointerCapture === 'function') target.setPointerCapture(pointerId);
}

function releasePointer(el: HTMLElement | undefined, pointerId: number): void {
	const target = el as { releasePointerCapture?(id: number): void } | undefined;
	if (typeof target?.releasePointerCapture === 'function') target.releasePointerCapture(pointerId);
}

function entryDate(entry: BasesEntry, property: BasesPropertyId | null): Date | null {
	if (!property) return null;

	return parseDateText(readEditableValue(entry, property));
}

function closest(el: HTMLElement, selector: string): HTMLElement | null {
	const candidate = el as unknown as { closest?(selector: string): HTMLElement | null };

	return typeof candidate.closest === 'function' ? candidate.closest(selector) : null;
}

function numberOf(el: HTMLElement | null, key: string): number {
	const value = (el as unknown as Record<string, unknown> | null)?.[key];

	return typeof value === 'number' ? value : 0;
}

/**
 * 날짜 속성 드롭다운에서 **날짜가 될 수 없는 것만** 뺀다(디자인 F — "날짜 타입만").
 *
 * 포함이 아니라 제외로 판정하는 이유는 빠뜨렸을 때 어느 쪽이 안전한가가 반대이기 때문이다. 목록에서
 * 빠지면 사용자가 자기 날짜 속성을 **고를 수 없어** 화면이 통째로 비고, 남으면 선택지가 하나 더 보일
 * 뿐이다. `file.ctime`·`file.mtime` 처럼 등록된 위젯이 없는 날짜도 이 방향이라야 살아남는다.
 */
function isDateCandidate(app: App, property: BasesPropertyId): boolean {
	const type = registeredPropertyType(app, property);

	return type !== 'checkbox' && type !== 'number' && type !== 'tags' && type !== 'multitext' && type !== 'aliases';
}

/** 체크박스로 쓸 수 있는 속성만. 여기서는 **포함 판정**이 맞다 — 등록 타입이 곧 체크박스 여부다. */
function isCheckboxCandidate(app: App, property: BasesPropertyId): boolean {
	return registeredPropertyType(app, property) === 'checkbox';
}

/**
 * 뷰 옵션 — 순서는 디자인 F 그대로이고, 마스터 1차 요청으로 칩 안 조작 속성 둘이 뒤에 붙었다.
 * 날짜 속성 둘이 맨 위인 이유는 이걸 정하지 않으면 화면이 비어 있기 때문이다.
 */
export function calendarViewOptions(app: App, config?: BasesViewConfig): BasesAllOptions[] {
	return [
		{
			type: 'property',
			key: START_DATE_KEY,
			displayName: t('Start date'),
			filter: (property: BasesPropertyId) => isDateCandidate(app, property),
		},
		{
			type: 'property',
			key: END_DATE_KEY,
			displayName: t('End date'),
			filter: (property: BasesPropertyId) => isDateCandidate(app, property),
		},
		{
			type: 'dropdown',
			key: MODE_KEY,
			displayName: t('View'),
			default: 'month',
			options: translateChoices(CALENDAR_MODE_CHOICES),
		},
		{
			type: 'text',
			key: ITEMS_PER_DAY_KEY,
			// 요구의 "윈도우 크기"가 이것이다 — 같은 일을 하는 옵션이 둘이 되지 않는다(확정 3).
			displayName: t('Items per day'),
			placeholder: String(DEFAULT_ITEMS_PER_DAY),
			// 주 보기는 `+N` 없이 전부 보여 주므로 이 값이 아무 일도 하지 않는다(마스터 1차 요청).
			shouldHide: () => false,
		},
		{
			type: 'dropdown',
			key: WEEK_START_KEY,
			displayName: t('Week starts on'),
			// 옵시디언에 첫 요일 설정이 없어 **화면 언어의 값**이 기본이다(디자인 B3).
			default: String(weekStartFor(screenLanguage())),
			options: translateChoices(WEEK_START_CHOICES),
		},
		{ type: 'toggle', key: WRAP_KEY, displayName: t('Wrap item text'), default: false },
		{
			type: 'toggle',
			key: SHOW_TASKS_KEY,
			// 켜면 본문을 읽어야 하고 화면 항목이 몇 배가 될 수 있어 기본은 꺼짐이다(F).
			displayName: t('Show tasks'),
			default: false,
		},
		{
			type: 'property',
			key: COLOR_BY_KEY,
			// 색 규칙은 **타임라인과 같은 키·같은 대화상자**다 — 한 base 에서 같은 값이 두 색이면 안 된다.
			displayName: t('Color by'),
		},
		{
			type: 'dropdown',
			key: PROPERTY_DISPLAY_KEY,
			displayName: t('Properties in item'),
			default: 'names',
			options: translateChoices(PROPERTY_DISPLAY_CHOICES),
		},
		{
			type: 'toggle',
			key: SHOW_EMPTY_KEY,
			// 두 표시 방식 **모두에서** 산다(3차 6번 — 값만 보기에서 옵션이 사라져 안 먹는 것으로 보였다).
			displayName: t('Show empty properties'),
			default: false,
		},
		{
			type: 'property',
			key: CHECKBOX_KEY,
			// 마스터 표현은 "title prefix" — 제목 앞에 서는 자리라 이름에 그대로 담았다.
			displayName: t('Checkbox before title'),
			filter: (property: BasesPropertyId) => isCheckboxCandidate(app, property),
		},
		{
			type: 'toggle',
			key: CHECKBOX_MISSING_KEY,
			displayName: t('Checkbox on notes without it'),
			default: false,
			shouldHide: () => !config?.get(CHECKBOX_KEY),
		},
		{
			type: 'property',
			key: LIST_KEY,
			displayName: t('Editable property'),
		},
		{
			type: 'dropdown',
			key: OPEN_MODE_KEY,
			displayName: t('Open items with'),
			default: DEFAULT_OPEN_MODE,
			options: openModeChoices(),
		},
	] as BasesAllOptions[];
}

export function createPlusCalendarRegistration(app: App): BasesViewRegistration {
	return {
		name: t('Plus calendar'),
		// 코어가 날짜·달력에 쓰는 그 글리프다.
		icon: 'calendar',
		factory: (controller, containerEl) => new PlusCalendarView(controller, containerEl),
		options: (config: BasesViewConfig) => calendarViewOptions(app, config),
	};
}

/** @returns Bases 코어 플러그인이 꺼져 있으면 false. */
export function registerPlusCalendarView(plugin: Plugin): boolean {
	return plugin.registerBasesView(PLUS_CALENDAR_VIEW_TYPE, createPlusCalendarRegistration(plugin.app));
}

export {
	MODE_KEY,
	ITEMS_PER_DAY_KEY,
	WEEK_START_KEY,
	WRAP_KEY,
	SHOW_TASKS_KEY,
	CHECKBOX_KEY,
	CHECKBOX_MISSING_KEY,
	LIST_KEY,
	PROPERTY_DISPLAY_KEY,
	SHOW_EMPTY_KEY,
};
