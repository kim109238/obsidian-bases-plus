import { BasesView, Menu, setTooltip } from 'obsidian';
import type {
	BasesAllOptions,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	BasesViewRegistration,
	Plugin,
	QueryController,
	TFile,
} from 'obsidian';
import {
	DEFAULT_OPEN_MODE,
	addOpenItem,
	openModeChoices,
	openTarget,
	resolveOpenMode,
} from '../shared/openTarget';
import type { OpenMode } from '../shared/openTarget';
import { readEditableValue } from './cellEditor';
import { createErrorEl, createNoticeEl, showViewError, syncNoticeEl } from './viewShell';
import { PALETTE_SIZE } from './barColors';
import { estimateTextWidth, screenLanguage } from './timelineAxis';
import {
	axisValueOf,
	buildCategoryAxis,
	buildNumberAxis,
	buildTimeAxis,
	buildValueAxis,
	collectCategories,
	detectAxisKind,
	linePaths,
	parseAxisNumber,
	ratioOf,
	thinByGap,
	windowRange,
} from './graphScale';
import type { Axis, AxisKind, PlotPoint } from './graphScale';
import { t, translateChoices } from '../shared/i18n';

/** `.base` 파일의 `views[].type` 에 그대로 기록된다. 바꾸면 기존 `.base` 가 뷰를 못 찾는다. */
export const PLUS_GRAPH_VIEW_TYPE = 'bases-plus-graph';

/**
 * 이 둘은 **화면을 조정하는 옵션이 아니라 화면이 성립하는 조건**이라 뷰 옵션 맨 위에 온다(디자인 F).
 * 정하지 않으면 플롯을 아예 그리지 않고 안내 띠가 대신 선다 — 빈 좌표축을 남기지 않는다(D).
 */
const X_PROPERTY_KEY = 'xProperty';
/**
 * 단위는 그리는 시리즈와 **같은 순서의 목록**이다. 한 칸에 섞으면(`note.매출:만원`) 구분자가 값에 들어갈 때
 * 깨진다(F). 시리즈 순서는 이제 툴바 Properties 목록이 정하므로, 단위도 그 순서를 따른다.
 */
const UNITS_KEY = 'yUnits';
/**
 * 보이는 x 구간의 폭(마스터 요청 0812 — "page 범위를 잡을 수 있도록 · 스크롤 가능한 형태").
 * 비우면 **전체**라 지금까지의 화면 그대로다 — 창은 값을 넣어야 생긴다.
 *
 * 단위는 축 종류가 정한다: 날짜 축은 **일**, 숫자 축은 **값 폭**. 범주 축에는 아무 일도 하지 않는다
 * (칸 수가 곧 폭이라 자를 자리가 없다).
 */
const X_WINDOW_KEY = 'xWindow';
const SHOW_DOTS_KEY = 'showDots';
const MISSING_VALUES_KEY = 'missingValues';
/** 열기 방식은 표·달력과 **같은 키**다 — 뷰를 바꿔도 고른 방식이 그대로 산다. */
const OPEN_MODE_KEY = 'openMode';

/** 우리 컨트롤 이름이라 영어다(확정 D3-B). */
const SHOW_DOTS_CHOICES: Record<string, string> = {
	always: 'Always',
	hover: 'On hover',
	auto: 'Auto',
};

const MISSING_VALUES_CHOICES: Record<string, string> = {
	break: 'Break line',
	connect: 'Connect',
};

/**
 * 플롯 여백(A2). 왼쪽은 y 눈금 글자 폭(`--size-4-9`), 아래는 x 눈금 한 줄(30px), 위·오른쪽은 `--size-4-2` 다.
 * 치수를 JS 가 아는 이유는 SVG 좌표가 px 이기 때문이고(스1 의 "색·크기 하드코딩"은 **테마가 정하는 값**을
 * 두고 하는 말이다), 화면에 칠하는 색·글꼴은 한 자리도 여기서 정하지 않는다.
 */
const PAD_LEFT = 36;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 30;

/** 점 지름(반지름 3 · C1). 이보다 가까운 점은 뭉쳐 보이므로 솎는다(확정 3). */
const DOT_DIAMETER = 6;
/**
 * 툴팁이 뜨기까지의 지연(ms) — 사실상 **즉시**다(마스터 2차 실기동: 300ms 도 느리다).
 *
 * **0 을 쓸 수 없다.** 코어는 옵션을 속성으로 옮길 때 `o && setAttribute("data-tooltip-delay", …)` 로
 * 참일 때만 쓰고(1.13.6 app.js 오프셋 1060639 `Yg`), 속성이 없으면 hover 때 기본값 1000ms 를 읽는다
 * (오프셋 1058520 `Ug` — `var o=Og` · `Og=1e3`). 즉 `delay: 0` 은 조용히 **1초로 되돌아간다.**
 * 그래서 공개 경로로 낼 수 있는 가장 빠른 값인 1 을 쓴다.
 *
 * 점을 훑을 때 튀지 않는 이유는 코어가 이미 막고 있어서다 — 툴팁을 감춘 뒤 100ms 안에 오는 다음 툴팁은
 * 지연 없이 뜨므로(`Kg` 의 `Date.now()>_g+Fg` · `Fg=100`), 이 값은 **한동안 멈춰 있다가 처음 올렸을 때**만
 * 관여한다. 마스터가 느리다고 한 자리가 정확히 그 자리다.
 */
const TOOLTIP_DELAY = 1;
/**
 * 툴팁이 서는 쪽. 기본값은 아래(`bottom`)라 **마우스 포인터가 값을 가린다**(마스터 2차 실기동).
 * `TooltipPlacement` 는 공개 타입이고(`'bottom' | 'right' | 'left' | 'top'`), 코어가 위쪽 자리와
 * `mod-top` 화살표까지 그려 준다 — 우리가 옮기는 것이 아니다.
 */
const TOOLTIP_PLACEMENT = 'top';
/** y 눈금 하나가 설 최소 높이. 이보다 촘촘하면 글자가 서로 붙는다. */
const Y_TICK_SLOT = 44;
/** y 눈금 글자의 세로 가운데. SVG `text` 는 기준선 정렬이라 글자 높이의 절반쯤을 내려야 선과 나란해진다. */
const TICK_BASELINE = 4;
/** x 눈금 글자가 축 선 아래 서는 자리. */
const TICK_BELOW = 16;
/** 하루(ms). 날짜 축의 창 폭이 **일** 단위라 축 좌표로 바꿀 때 쓴다. */
const DAY_MS = 86400000;

/**
 * 레이아웃이 없는 환경(하네스)에서도 좌표가 서야 한다 — 0 으로 그리면 점이 전부 한자리에 겹쳐
 * 무엇이 잘못됐는지 화면으로 알 수 없다. 실물에서는 언제나 잰 값이 쓰인다.
 */
const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 240;

const NOTICE_NEEDS_PROPERTIES = 'Choose an X and Y property to draw the graph.';
const NOTICE_NO_VALUES = 'No numeric values to plot in the selected Y properties.';

/** x 순서 목록의 한 자리. 행 하나가 자리 하나이고, 시리즈들이 이 자리 위에 값을 얹는다. */
interface GraphSlot {
	/** 축 좌표(시간=ms · 숫자=값 · 범주=등장 순번). */
	x: number;
	/** 툴팁에 그대로 쓰는 저장 문자열 — 속성 렌더 규칙대로 `Value.toString()` 이다(E). */
	xText: string;
	label: string;
	file: TFile | null;
}

interface SeriesPoint {
	slot: number;
	y: number;
	yText: string;
}

interface GraphSeries {
	/** 범례 토글이 시리즈를 가리키는 열쇠. 요소가 아니라 속성 id 로 잡아야 갱신을 넘어 살아남는다. */
	property: BasesPropertyId;
	name: string;
	unit: string;
	/** 팔레트 번호 1~8. 아홉째 시리즈부터는 색을 돌려 쓰고 선을 파선으로 바꾼다(C2). */
	color: number;
	dashed: boolean;
	points: SeriesPoint[];
}

/**
 * 이번 갱신에 그릴 것 전부. **좌표는 아직 없다** — 폭·높이가 바뀌면 이 계획을 그대로 두고 자리만 다시 잡는다.
 * 값을 다시 읽지 않는 것이 크기 변화에서 성1 을 지키는 방법이다.
 */
interface GraphPlan {
	kind: AxisKind;
	categories: string[];
	slots: GraphSlot[];
	series: GraphSeries[];
	/** x 값이 없어 빠진 행 수(D). */
	skipped: number;
}

/** 점 하나가 알아야 할 것. 리스너는 만들 때 한 번만 걸고 여기 값만 갈아 끼운다(성2). */
interface GraphDot {
	el: HTMLElement;
	file: TFile | null;
}

interface LegendItem {
	el: HTMLElement;
	swatchEl: HTMLElement;
	nameEl: HTMLElement;
	/** 이 줄이 지금 맡은 시리즈. 요소는 재사용되므로 클릭 시점에 여기서 읽는다. */
	property: BasesPropertyId | null;
}

/** 크기 감시자 — 웹 표준 `ResizeObserver` 다(모2). 없는 환경에서는 감시 없이 갱신 때만 자리를 잡는다. */
interface SizeWatcher {
	observe(el: HTMLElement): void;
	disconnect(): void;
}

/**
 * 그래프 — **새로 그리는 것은 축·선·점이 있는 플롯 하나**다(디자인 결론).
 *
 * 표를 상속하지 않는다. 그래프는 열·행·그룹·페이징을 하나도 쓰지 않고(E), x 축이 자리를 정하므로
 * 순서·페이지가 배치를 바꿀 수 없다. 대신 **모듈을 계승한다** — 열기(`openTarget`)·값 읽기
 * (`cellEditor.readEditableValue`)·안내 띠와 오류 줄(`viewShell`)·화면 언어(`timelineAxis`)·
 * 색표(`barColors` 의 팔레트 자리 수)가 전부 확정분 그대로다.
 *
 * **점만 HTML 이다.** 나머지(격자·축·선)는 SVG 인데, 점은 옵시디언 툴팁이 붙는 자리라 SVG 로 둘 수 없다 —
 * 코어 툴팁 렌더러가 대상 요소에 `isShown()` 을 부르는데 그 헬퍼는 `HTMLElement.prototype` 에만 있어
 * (1.13.6 `enhance.js` 실측: SVG 에는 `show`·`hide`·`on`·`isShown` 이 없다) SVG 원에 `setTooltip` 을 걸면
 * 값이 뜨는 대신 hover 마다 TypeError 가 난다. 점을 HTML 로 두면 툴팁·커서·클릭이 전부 확정분 경로를 탄다.
 */
export class PlusGraphView extends BasesView {
	type = PLUS_GRAPH_VIEW_TYPE;

	private readonly containerEl: HTMLElement;
	private readonly rootEl: HTMLElement;
	private readonly graphEl: HTMLElement;
	private readonly noticeEl: HTMLElement;
	private readonly legendEl: HTMLElement;
	/** 플롯의 자리 상자. **높이를 이 요소가 정한다** — 안쪽 둘은 절대 배치라 크기에 관여하지 않는다. */
	private readonly plotEl: HTMLElement;
	private readonly canvasEl: SVGElement;
	private readonly gridEl: SVGElement;
	private readonly axisEl: SVGElement;
	private readonly linesEl: SVGElement;
	private readonly dotsEl: HTMLElement;
	/**
	 * 창을 옮기는 자리. **네이티브 가로 스크롤바 그 자체다** — 우리가 손잡이를 그리지 않고, 안쪽 띠의 폭이
	 * 전체 구간을, 스크롤 위치가 창의 자리를 뜻한다. 창이 없으면 요소째 감춘다.
	 */
	private readonly railEl: HTMLElement;
	private readonly railTrackEl: HTMLElement;
	private readonly errorEl: HTMLElement;
	private readonly legendItems: LegendItem[] = [];
	/** 점 요소 풀. 갱신마다 다시 만들지 않는다(성2). */
	private readonly dots: GraphDot[] = [];
	private plan: GraphPlan | null = null;
	/**
	 * 범례로 감춘 시리즈. **저장하지 않는다** — 보고 있는 상태이지 뷰 설정이 아니다(표의 페이지·달력의 펼침과
	 * 같은 판단). 갱신을 넘어 살아 있어야 하므로 요소가 아니라 속성 id 로 들고 있는다.
	 */
	private readonly hidden = new Set<string>();
	/**
	 * 창이 선 자리(0=왼쪽 끝 · 1=오른쪽 끝). **저장하지 않는다** — 창의 *폭*은 뷰 설정이지만 *자리*는
	 * 보고 있는 위치다(타임라인이 배율만 저장하고 스크롤은 안 하는 것과 같은 선). 처음에는 오른쪽 끝이다 —
	 * 날짜 축에서 사람이 먼저 보는 것은 최근이다.
	 */
	private windowAt = 1;
	private lastWidth = 0;
	private lastHeight = 0;

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);

		this.containerEl = containerEl;
		this.rootEl = containerEl.createDiv({ cls: 'bases-plus-view is-graph' });
		this.graphEl = this.rootEl.createDiv({ cls: 'bases-plus-graph' });

		this.noticeEl = createNoticeEl(this.graphEl);
		// 범례가 **위**인 이유 — 무엇을 보고 있는지가 먼저다(A2).
		this.legendEl = this.graphEl.createDiv({ cls: 'bases-plus-graph-legend' });
		this.plotEl = this.graphEl.createDiv({ cls: 'bases-plus-graph-plot' });
		this.canvasEl = this.plotEl.createSvg('svg', { cls: 'bases-plus-graph-canvas' });
		this.gridEl = this.canvasEl.createSvg('g', { cls: 'bases-plus-graph-grid' });
		this.axisEl = this.canvasEl.createSvg('g', { cls: 'bases-plus-graph-axis' });
		this.linesEl = this.canvasEl.createSvg('g', { cls: 'bases-plus-graph-lines' });
		this.dotsEl = this.plotEl.createDiv({ cls: 'bases-plus-graph-dots' });
		this.railEl = this.graphEl.createDiv({ cls: 'bases-plus-graph-rail' });
		this.railTrackEl = this.railEl.createDiv({ cls: 'bases-plus-graph-rail-track' });
		this.errorEl = createErrorEl(this.rootEl);

		this.railEl.hide();
		this.registerDomEvent(this.railEl, 'scroll', () => this.onRailScroll());
		/*
		 * 휠은 **가로 뜻이 분명할 때만** 가로챈다(가로 스크롤 제스처·Shift). 세로 휠까지 먹으면 노트를
		 * 읽어 내려가다 그래프 위에서 멈춘다 — 타임라인이 확대에 Cmd 를 요구한 것과 같은 판단이다.
		 */
		this.registerDomEvent(this.plotEl, 'wheel', (evt) => this.onWheel(evt as WheelEvent), { passive: false });

		this.watchResize();
	}

	onunload(): void {
		this.rootEl.remove();
		this.dots.length = 0;
		this.legendItems.length = 0;
		this.hidden.clear();
	}

	onDataUpdated(): void {
		// 네이티브 뷰 3종이 모두 여기서 is-loading 을 뗀다. 빠뜨리면 로딩 표시가 남는다.
		this.containerEl.removeClass('is-loading');

		try {
			this.render();
			this.errorEl.hide();
		} catch (error) {
			console.error('Bases Plus: rendering the graph failed.', error);
			showViewError(this.errorEl);
		}
	}

	private render(): void {
		const xProperty = this.readProperty(X_PROPERTY_KEY);
		const properties = xProperty === null ? [] : this.seriesProperties(xProperty);

		if (xProperty === null || properties.length === 0) {
			// 빈 좌표축을 그려 두지 않는다 — 그릴 것이 없는데 축만 있으면 데이터가 없는 건지 설정이 안 된 건지 모른다(D).
			this.plan = null;
			this.legendEl.hide();
			this.plotEl.hide();
			// 플롯이 없으면 옮길 창도 없다 — 띠만 남으면 아무 데도 닿지 않는 컨트롤이 선다.
			this.railEl.hide();
			syncNoticeEl(this.noticeEl, NOTICE_NEEDS_PROPERTIES);
			return;
		}

		this.plan = this.collect(xProperty, properties);
		this.legendEl.show();
		this.plotEl.show();
		this.layout(this.plan);
		syncNoticeEl(this.noticeEl, this.noticeFor(this.plan));
	}

	// ── 값 모으기 ───────────────────────────────────────────────────────────────────

	/**
	 * 그릴 시리즈의 출처는 **네이티브 속성 설정**이다(마스터 요청 0812 — "기본 UI 를 그대로 쓰고 싶다").
	 * 툴바 Properties 메뉴가 정한 표시 속성이 `data.properties` 로 그대로 넘어온다(공개 · 표 뷰의 열과 같은 값).
	 *
	 * 그래서 이 뷰에는 속성을 손으로 적는 옵션이 없다 — 그 옵션은 "공개 옵션에 속성 여럿이 없다"는 사정 때문에
	 * 있었고, 네이티브 목록이 그 자리를 대신하면서 사정이 사라졌다.
	 *
	 * x 는 뺀다. 같은 base 를 표로도 보므로 x 속성은 목록에 거의 늘 있는데, 그것까지 그리면 **가로축 값이
	 * 세로축에도 서서** 언제나 우상향하는 무의미한 선이 하나 생긴다.
	 */
	private seriesProperties(xProperty: BasesPropertyId): BasesPropertyId[] {
		const visible = this.data?.properties ?? [];

		return visible.filter((property) => !isSameProperty(property, xProperty));
	}

	/**
	 * 쿼리 행에서 자리와 시리즈를 만든다. **정렬은 x 오름차순이고 툴바 정렬과 무관하다** —
	 * 선 그래프에서 x 순서는 선택이 아니라 정의다(B1).
	 */
	private collect(xProperty: BasesPropertyId, properties: BasesPropertyId[]): GraphPlan {
		const entries = this.data?.data ?? [];
		const texts: string[] = [];

		for (const entry of entries) texts.push(readEditableValue(entry, xProperty));

		const kind = detectAxisKind(texts);
		const categories = kind === 'category' ? collectCategories(texts) : [];
		const rows: { slot: GraphSlot; entry: BasesEntry }[] = [];
		let skipped = 0;

		entries.forEach((entry, index) => {
			const x = axisValueOf(texts[index], kind, categories);
			// x 가 없으면 그릴 자리가 없다 — 그 행만 빠지고 몇 개가 빠졌는지는 안내 띠가 말한다(D).
			if (x === null) {
				skipped++;
				return;
			}

			rows.push({
				slot: { x, xText: texts[index], label: entry.file?.basename ?? '', file: entry.file ?? null },
				entry,
			});
		});

		rows.sort((a, b) => a.slot.x - b.slot.x);

		const units = this.readUnits();
		const series: GraphSeries[] = [];

		properties.forEach((property) => {
			const points: SeriesPoint[] = [];

			rows.forEach((row, slot) => {
				const text = readEditableValue(row.entry, property);
				const y = parseAxisNumber(text);
				// 숫자가 아닌 값은 **그 점만** 건너뛴다. 행을 버리지 않는다 — 다른 시리즈에는 값이 있을 수 있다(D).
				if (y === null) return;

				points.push({ slot, y, yText: text });
			});

			/*
			 * 숫자 값이 하나도 없는 속성은 시리즈가 되지 않는다 — 속성 목록에는 이름·태그처럼 그릴 수 없는
			 * 것이 함께 들어 있고, 그것들이 팔레트 자리를 먹으면 **첫 선이 파랑이 아니게 된다.**
			 * 그래서 색은 목록 자리가 아니라 **실제로 그리는 순서**로 매긴다.
			 */
			if (points.length === 0) return;

			const index = series.length;

			series.push({
				property,
				name: this.displayName(property),
				unit: units[index] ?? '',
				color: (index % PALETTE_SIZE) + 1,
				dashed: index >= PALETTE_SIZE,
				points,
			});
		});

		return { kind, categories, slots: rows.map((row) => row.slot), series, skipped };
	}

	private noticeFor(plan: GraphPlan): string | null {
		const lines: string[] = [];

		// 축만 그리고 안내 띠를 세운다 — 빈 화면을 남기지 않는다(D).
		if (plan.series.length === 0) lines.push(t(NOTICE_NO_VALUES));
		if (plan.skipped > 0) {
			lines.push(
				plan.skipped === 1
					? t('1 row has no X value and is not drawn.')
					: t('{{count}} rows have no X value and are not drawn.', { count: plan.skipped })
			);
		}

		return lines.length === 0 ? null : lines.join(' ');
	}

	// ── 자리 잡기 ───────────────────────────────────────────────────────────────────

	/**
	 * 잰 상자에 맞춰 축을 다시 계산하고 화면을 맞춘다. **값은 다시 읽지 않는다** — 크기가 바뀌었을 때
	 * 이 함수만 다시 도는 것이 성1 을 지키는 방법이다.
	 */
	private layout(plan: GraphPlan): void {
		const width = numberOf(this.plotEl, 'clientWidth') || FALLBACK_WIDTH;
		const height = numberOf(this.plotEl, 'clientHeight') || FALLBACK_HEIGHT;

		this.lastWidth = width;
		this.lastHeight = height;
		this.canvasEl.setAttr('width', String(width));
		this.canvasEl.setAttr('height', String(height));

		const top = PAD_TOP;
		const bottom = Math.max(top + 1, height - PAD_BOTTOM);
		const locale = screenLanguage();

		/*
		 * 감춘 시리즈는 **축 계산에서도 빠진다.** 감추는 이유가 대개 "큰 값이 작은 값을 눌러 평평해졌다"는
		 * 것이라(확정 2), 자리를 비켜 주지 않으면 감춰도 남은 선이 그대로 바닥에 붙어 있다.
		 */
		const shown = plan.series.filter((series) => !this.hidden.has(series.property));
		const values: number[] = [];
		for (const series of shown) {
			for (const point of series.points) values.push(point.y);
		}

		// y 축은 **높이만** 보고 서므로 먼저 세운다 — 그 눈금 글자가 왼쪽 여백을 정한다.
		const yAxis = buildValueAxis(values, Math.max(2, Math.floor((bottom - top) / Y_TICK_SLOT)), locale);
		/*
		 * 왼쪽 여백은 **눈금 글자 폭만큼**이다(A2 — 36px 은 기본값이지 상한이 아니다). 고정으로 두면
		 * 값이 커졌을 때 맨 위 눈금(`6,000`)의 앞자리가 뷰 밖으로 잘린다(헤드리스 실측 — 400행 화면).
		 */
		const widest = yAxis.ticks.reduce((at, tick) => Math.max(at, estimateTextWidth(tick.label)), 0);
		const left = Math.min(
			// 아무리 긴 눈금이라도 플롯의 절반을 먹지는 않는다 — 그때는 글자가 잘리는 편이 낫다.
			Math.max(1, Math.round(width / 2)),
			Math.max(PAD_LEFT, Math.ceil(widest) + TICK_BASELINE + 2)
		);
		const right = Math.max(left + 1, width - PAD_RIGHT);
		const xAxis = this.buildXAxis(plan, right - left, locale);
		const xOf = (value: number): number => left + ratioOf(xAxis, value) * (right - left);
		const yOf = (value: number): number => bottom - ratioOf(yAxis, value) * (bottom - top);

		this.syncLegend(plan.series);
		this.syncGrid(yAxis, yOf, left, right);
		this.syncAxis(xAxis, xOf, left, right, bottom);
		// 선은 플롯 구간에서 잘린다 — 창 밖으로 뻗으면 y 눈금 글자와 뷰 바깥까지 덧칠한다.
		this.syncSeries(plan, shown, xOf, yOf, { from: left, to: right });
		this.syncRail(plan, right - left, left, width);
	}

	private buildXAxis(plan: GraphPlan, width: number, locale: string): Axis {
		// 범주 축은 칸 수가 곧 폭이라 자를 자리가 없다 — 창 옵션이 아무 일도 하지 않는다.
		if (plan.kind === 'category') return buildCategoryAxis(plan.categories, width);

		const xs = plan.slots.map((slot) => slot.x);

		if (plan.kind === 'number') {
			const full = buildNumberAxis(xs, width, locale);
			const size = this.windowSize(plan.kind);
			if (size === null) return full;

			// 창을 잡으면 **그 구간이 축의 전부**다. 눈금은 창 폭으로 다시 골라져 촘촘해진다(B1).
			const at = windowRange(full.min, full.max, size, this.windowAt);

			return buildNumberAxis([at.min, at.max], width, locale);
		}

		// 시간 축은 데이터의 양 끝이 그대로 축의 양 끝이다 — 첫 점이 y 축 위에 선다(목업과 같다).
		const min = xs.length > 0 ? xs[0] : 0;
		const max = xs.length > 0 ? xs[xs.length - 1] : 1;
		const size = this.windowSize(plan.kind);
		const at = size === null ? { min, max } : windowRange(min, max, size, this.windowAt);

		return buildTimeAxis(at.min, at.max, width, locale);
	}

	/**
	 * 창 폭을 축 좌표로 환산한다. 날짜 축은 **일**, 숫자 축은 **값 폭**이다 — 한 칸에 두 뜻을 담는 대신
	 * 축 종류가 단위를 정한다(그래야 옵션이 하나로 끝난다). 안 정했거나 이상한 값이면 창이 없다.
	 */
	private windowSize(kind: AxisKind): number | null {
		if (kind === 'category') return null;

		const stored = Number(this.config.get(X_WINDOW_KEY));
		if (!Number.isFinite(stored) || stored <= 0) return null;

		return kind === 'time' ? stored * DAY_MS : stored;
	}

	/**
	 * 전체 구간의 폭. 창이 전체의 몇 분의 몇인지를 스크롤 띠 길이로 옮길 때 쓴다.
	 */
	private fullSpan(plan: GraphPlan): number {
		const xs = plan.slots.map((slot) => slot.x);
		if (xs.length === 0) return 0;

		return xs[xs.length - 1] - xs[0];
	}

	// ── 범례 ────────────────────────────────────────────────────────────────────────

	/** 범례 점과 선은 **같은 변수**를 쓴다 — 둘이 어긋나면 범례가 거짓말이 된다(C2). */
	private syncLegend(series: GraphSeries[]): void {
		while (this.legendItems.length < series.length) this.legendItems.push(this.createLegendItem());

		this.legendItems.forEach((item, index) => {
			const found = series[index];

			if (!found) {
				item.property = null;
				item.el.hide();
				return;
			}

			const off = this.hidden.has(found.property);

			item.property = found.property;
			item.el.show();
			item.swatchEl.setCssProps({ '--bases-plus-graph-color': `var(--bases-plus-series-${found.color})` });
			item.swatchEl.toggleClass('is-dashed', found.dashed);
			// 단위는 눈금이 아니라 여기 붙는다 — 시리즈마다 단위가 다르면 축 하나에 두 단위가 붙어 거짓이 된다(B2).
			item.nameEl.setText(found.unit === '' ? found.name : `${found.name}(${found.unit})`);
			// 감춘 시리즈는 **자리를 지키고 흐려진다** — 사라지면 다시 켤 곳이 없다.
			item.el.toggleClass('is-off', off);
			item.el.setAttr('aria-pressed', String(!off));
			item.el.setAttr('aria-label', t(off ? 'Show {{name}}' : 'Hide {{name}}', { name: found.name }));
		});
	}

	/**
	 * 범례 한 줄. **누르면 그 시리즈가 감춰진다**(마스터 요청 0812). 리스너는 만들 때 한 번만 걸고
	 * 어느 시리즈인지는 갱신 때 갈아 끼운다(성2 — 요소 재사용).
	 */
	private createLegendItem(): LegendItem {
		const el = this.legendEl.createEl('button', {
			cls: 'bases-plus-graph-legend-item',
			attr: { type: 'button' },
		});
		const item: LegendItem = {
			el,
			swatchEl: el.createDiv({ cls: 'bases-plus-graph-swatch' }),
			nameEl: el.createSpan({ cls: 'bases-plus-graph-legend-name' }),
			property: null,
		};

		this.registerDomEvent(el, 'click', (evt) => {
			if (!item.property) return;

			evt.preventDefault();
			this.toggleSeries(item.property);
		});

		return item;
	}

	/**
	 * 시리즈 감추기·되살리기. **저장하지 않는다** — 보고 있는 상태이지 뷰 설정이 아니다(표의 페이지·달력의
	 * 펼침과 같은 판단). 임베드에서는 설정을 쓸 때마다 호스트 노트가 다시 쓰이므로 클릭 한 번에 노트가
	 * 고쳐지는 것도 피한다.
	 */
	private toggleSeries(property: BasesPropertyId): void {
		if (this.hidden.has(property)) this.hidden.delete(property);
		else this.hidden.add(property);

		if (this.plan) this.layout(this.plan);
	}

	// ── 격자·축 ─────────────────────────────────────────────────────────────────────

	/**
	 * 격자와 y 눈금. 눈금 수는 열 개를 넘지 않아(높이가 정한다) **갱신마다 다시 세운다** —
	 * 타임라인의 축 층과 같은 판단이다. 개수가 행 수를 따라 늘어나는 것은 점뿐이고 그쪽만 풀을 쓴다.
	 */
	private syncGrid(axis: Axis, yOf: (value: number) => number, left: number, right: number): void {
		this.gridEl.empty();

		for (const tick of axis.ticks) {
			const at = yOf(tick.value);

			this.gridEl.createSvg('line', {
				attr: { x1: left, y1: at, x2: right, y2: at },
			});
			this.gridEl.createSvg('text', {
				attr: { x: left - TICK_BASELINE - 2, y: at + TICK_BASELINE, 'text-anchor': 'end' },
			}).setText(tick.label);
		}
	}

	private syncAxis(
		axis: Axis,
		xOf: (value: number) => number,
		left: number,
		right: number,
		bottom: number
	): void {
		this.axisEl.empty();
		this.axisEl.createSvg('line', { attr: { x1: left, y1: bottom, x2: right, y2: bottom } });

		axis.ticks.forEach((tick, index) => {
			// 양 끝 글자는 안쪽으로 붙인다 — 가운데 정렬로 두면 축 밖으로 절반이 나가 잘린다.
			const anchor = index === 0 ? 'start' : index === axis.ticks.length - 1 ? 'end' : 'middle';

			this.axisEl.createSvg('text', {
				attr: { x: xOf(tick.value), y: bottom + TICK_BELOW, 'text-anchor': anchor },
			}).setText(tick.label);
		});
	}

	// ── 선·점 ───────────────────────────────────────────────────────────────────────

	private syncSeries(
		plan: GraphPlan,
		shown: GraphSeries[],
		xOf: (value: number) => number,
		yOf: (value: number) => number,
		clip: { from: number; to: number }
	): void {
		const connect = this.config.get(MISSING_VALUES_KEY) === 'connect';
		const mode = this.readShowDots();
		let used = 0;
		let thinned = false;

		this.linesEl.empty();

		for (const series of shown) {
			const points: PlotPoint[] = series.points.map((point) => ({
				x: xOf(plan.slots[point.slot].x),
				y: yOf(point.y),
				slot: point.slot,
			}));

			for (const path of linePaths(points, connect, clip)) {
				const pathEl = this.linesEl.createSvg('path', { cls: 'bases-plus-graph-line', attr: { d: path } });
				pathEl.setCssProps({ '--bases-plus-graph-color': `var(--bases-plus-series-${series.color})` });
				// 아홉째 시리즈부터는 색이 첫째와 같다 — 파선이 둘을 가른다(C2).
				pathEl.toggleClass('is-dashed', series.dashed);
			}

			// 점이 지름보다 가까우면 솎는다 — 그대로 두면 선이 두꺼운 띠가 되고 요소도 행 수만큼 늘어난다(확정 3).
			const keep = thinByGap(points.map((point) => point.x), DOT_DIAMETER);

			series.points.forEach((point, index) => {
				if (!keep[index]) {
					thinned = true;
					return;
				}

				// 창 밖의 점은 그리지 않는다 — 선은 경계에서 잘리는데 점만 남으면 축 밖에 떠 있게 된다.
				if (points[index].x < clip.from - 0.5 || points[index].x > clip.to + 0.5) return;

				const slot = plan.slots[point.slot];
				const dot = this.getDot(used++);

				dot.file = slot.file;
				dot.el.show();
				dot.el.setCssStyles({ left: `${points[index].x}px`, top: `${points[index].y}px` });
				dot.el.setCssProps({ '--bases-plus-graph-color': `var(--bases-plus-series-${series.color})` });
				/*
				 * 문구는 `이름 · x값 · y값(단위)` 한 줄이다(C3). 값은 속성 렌더 규칙대로 저장된 문자열 그대로다.
				 * 지연과 자리는 둘 다 공개 옵션이다 — 우리가 툴팁을 그리지도, 옮기지도 않는다(위 두 상수).
				 */
				setTooltip(
					dot.el,
					`${slot.label} · ${slot.xText} · ${series.name} ${point.yText}${series.unit}`,
					{ delay: TOOLTIP_DELAY, placement: TOOLTIP_PLACEMENT }
				);
			});
		}

		for (let i = used; i < this.dots.length; i++) {
			this.dots[i].file = null;
			this.dots[i].el.hide();
		}

		/*
		 * `Auto` 는 **점이 뭉치기 시작하면 선만 남긴다**(확정 3). 솎였다는 것이 곧 뭉쳤다는 뜻이므로
		 * 자동 판단의 근거를 따로 두지 않는다 — 자리는 남아 있어 호버하면 그 점만 드러난다.
		 */
		const hover = mode === 'hover' || (mode === 'auto' && thinned);
		this.dotsEl.toggleClass('is-hover-only', hover);
	}

	/**
	 * 스크롤 띠 — **창이 있을 때만** 선다. 안쪽 띠의 폭이 `플롯 폭 × (전체 / 창)` 이라 손잡이의 길이가
	 * 곧 "전체 중 얼마를 보고 있나" 가 되고, 위치가 창의 자리가 된다. 네이티브 스크롤바를 그대로 쓴다.
	 */
	private syncRail(plan: GraphPlan, plotWidth: number, left: number, width: number): void {
		const size = this.windowSize(plan.kind);
		const span = this.fullSpan(plan);

		// 창이 없거나 데이터보다 넓으면 움직일 것이 없다 — 띠를 세우지 않는다.
		if (size === null || span <= 0 || size >= span) {
			this.railEl.hide();
			return;
		}

		this.railEl.show();
		// 띠는 축과 나란히 선다 — 왼쪽 눈금 글자 자리만큼 안쪽에서 시작한다(그 폭은 눈금이 정한다).
		this.railEl.setCssProps({
			'--bases-plus-graph-rail-start': `${left}px`,
			'--bases-plus-graph-rail-end': `${Math.max(0, width - plotWidth - left)}px`,
		});
		this.railTrackEl.setCssStyles({ width: `${Math.round(plotWidth * (span / size))}px` });

		const max = Math.max(0, numberOf(this.railTrackEl, 'offsetWidth') - numberOf(this.railEl, 'clientWidth'));
		const target = Math.round(max * this.windowAt);
		// 우리 상태가 정본이다 — 띠는 입력 장치라 계산된 자리로 맞춰 둔다(스크롤 이벤트는 같은 값이면 조용하다).
		if (max > 0 && Math.abs(numberOf(this.railEl, 'scrollLeft') - target) > 1) this.setRailScroll(target);
	}

	private setRailScroll(value: number): void {
		const target = this.railEl as unknown as { scrollLeft?: number };
		if (typeof target.scrollLeft !== 'number') return;

		target.scrollLeft = value;
	}

	/** 띠를 끌면 창이 옮겨진다. 값이 실제로 바뀔 때만 다시 그린다 — 같은 자리에 다시 그리면 스크롤이 튄다. */
	private onRailScroll(): void {
		const plan = this.plan;
		if (!plan) return;

		const max = Math.max(0, numberOf(this.railTrackEl, 'offsetWidth') - numberOf(this.railEl, 'clientWidth'));
		if (max <= 0) return;

		const at = Math.min(1, Math.max(0, numberOf(this.railEl, 'scrollLeft') / max));
		if (Math.abs(at - this.windowAt) < 0.0005) return;

		this.windowAt = at;
		this.layout(plan);
	}

	/**
	 * 휠로 창을 옮긴다. **가로 뜻이 분명할 때만** 가로챈다 — 세로 휠은 노트·뷰의 스크롤로 그대로 넘긴다.
	 */
	private onWheel(evt: WheelEvent): void {
		if (this.railEl.hidden) return;

		const horizontal = evt.shiftKey ? evt.deltaY : evt.deltaX;
		if (horizontal === 0 || (!evt.shiftKey && Math.abs(evt.deltaX) <= Math.abs(evt.deltaY))) return;

		evt.preventDefault();
		this.setRailScroll(numberOf(this.railEl, 'scrollLeft') + horizontal);
		// 실물은 스크롤 이벤트가 뒤따르지만, 레이아웃이 없는 환경에서는 그 이벤트가 없다 — 직접 반영한다.
		this.onRailScroll();
	}

	private getDot(index: number): GraphDot {
		while (this.dots.length <= index) this.dots.push(this.createDot());

		return this.dots[index];
	}

	private createDot(): GraphDot {
		const el = this.dotsEl.createDiv({ cls: 'bases-plus-graph-dot' });
		const dot: GraphDot = { el, file: null };

		el.hide();

		// 리스너는 요소를 만들 때 한 번만 건다. 갱신마다 걸면 등록이 누적된다(성2).
		this.registerDomEvent(el, 'click', (evt) => {
			if (!dot.file) return;
			// 수식어·보조 버튼 클릭은 코어 동작에 그대로 넘긴다.
			if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

			evt.preventDefault();
			evt.stopPropagation();
			void openTarget(this.app, dot.file, this.getOpenMode());
		});
		this.registerDomEvent(el, 'contextmenu', (evt) => {
			if (evt.defaultPrevented || !dot.file) return;

			evt.preventDefault();
			const menu = new Menu();
			addOpenItem(menu, this.app, dot.file, this.getOpenMode());
			menu.showAtMouseEvent(evt);
		});

		return dot;
	}

	// ── 크기 ────────────────────────────────────────────────────────────────────────

	/**
	 * 폭이 바뀌면 눈금 개수부터 달라진다(B1) — 갱신 때만 자리를 잡으면 판을 넓힌 뒤로 선이 옛 폭에 남는다.
	 * 감시는 **웹 표준**이라 모바일에서도 살아 있고(모2), 정리는 `register` 가 맡는다(성5).
	 */
	private watchResize(): void {
		const view = this.plotEl.ownerDocument?.defaultView as
			| { ResizeObserver?: new (callback: () => void) => SizeWatcher }
			| undefined;
		if (typeof view?.ResizeObserver !== 'function') return;

		const observer = new view.ResizeObserver(() => this.onResized());

		observer.observe(this.plotEl);
		this.register(() => observer.disconnect());
	}

	private onResized(): void {
		const plan = this.plan;
		const width = numberOf(this.plotEl, 'clientWidth') || FALLBACK_WIDTH;
		const height = numberOf(this.plotEl, 'clientHeight') || FALLBACK_HEIGHT;
		if (!plan || (width === this.lastWidth && height === this.lastHeight)) return;

		try {
			this.layout(plan);
		} catch (error) {
			console.error('Bases Plus: laying out the graph failed.', error);
			showViewError(this.errorEl);
		}
	}

	// ── 뷰 옵션 읽기 ────────────────────────────────────────────────────────────────

	private readProperty(key: string): BasesPropertyId | null {
		try {
			return this.config.getAsPropertyId(key);
		} catch (error) {
			const raw = this.config.get(key);

			return typeof raw === 'string' && raw !== '' ? (raw as BasesPropertyId) : null;
		}
	}

	/** 단위 목록. y 와 **같은 순서**이고 없는 자리는 빈 문자열이다(F). */
	private readUnits(): string[] {
		return this.readLines(UNITS_KEY);
	}

	private readLines(key: string): string[] {
		const stored = this.config.get(key);
		const lines = Array.isArray(stored) ? stored : typeof stored === 'string' ? [stored] : [];

		return lines
			.filter((line): line is string => typeof line === 'string')
			.map((line) => line.trim())
			.filter((line) => line !== '');
	}

	private readShowDots(): string {
		const stored = this.config.get(SHOW_DOTS_KEY);

		return typeof stored === 'string' && SHOW_DOTS_CHOICES[stored] !== undefined ? stored : 'auto';
	}

	/** 속성 이름. 고른 줄이 속성이 아니면 코어가 이름을 못 내므로 적힌 값을 그대로 쓴다. */
	private displayName(property: BasesPropertyId): string {
		try {
			return this.config.getDisplayName(property) || String(property);
		} catch (error) {
			return String(property);
		}
	}

	private getOpenMode(): OpenMode {
		return resolveOpenMode(this.config.get(OPEN_MODE_KEY));
	}
}

/**
 * 두 속성 지시가 같은 것을 가리키는가. **접두사가 붙은 형태와 안 붙은 형태를 같게 본다** —
 * `.base` 파일의 속성 목록은 노트 속성을 접두사 없이 적고(`시작`·`status` · Demo.base 실물), `file.*` 만
 * 접두사를 지킨다. x 를 시리즈에서 뺄 때 이 둘을 다르게 보면 **가로축 값이 세로축에도 서는** 선이 하나 생긴다.
 */
function isSameProperty(a: BasesPropertyId, b: BasesPropertyId): boolean {
	if (a === b) return true;

	const left = String(a);
	const right = String(b);

	// 점이 없는 쪽은 노트 속성이다 — 그쪽에만 접두사를 붙여 견준다.
	if (left.indexOf('.') === -1) return `note.${left}` === right;
	if (right.indexOf('.') === -1) return `note.${right}` === left;

	return false;
}

function numberOf(el: HTMLElement | null, key: string): number {
	const value = (el as unknown as Record<string, unknown> | null)?.[key];

	return typeof value === 'number' ? value : 0;
}

/**
 * 뷰 옵션 — 순서는 디자인 F 그대로다. x·y 가 맨 위인 이유는 이걸 정하지 않으면 화면이 비어 있기 때문이다.
 */
export function graphViewOptions(): BasesAllOptions[] {
	return [
		{ type: 'property', key: X_PROPERTY_KEY, displayName: t('X property') },
		/*
		 * **y 속성 목록이 여기 없다.** 그릴 시리즈는 툴바 Properties 메뉴가 정한다(위 `seriesProperties`) —
		 * 손으로 속성 id 를 적던 옵션은 그 목록으로 대체됐다(마스터 요청 0812).
		 */
		{
			type: 'text',
			key: X_WINDOW_KEY,
			// 비우면 전체다 — 창은 값을 넣어야 생긴다(날짜 축은 일, 숫자 축은 값 폭).
			displayName: t('X window'),
			placeholder: t('All'),
		},
		{
			type: 'multitext',
			key: UNITS_KEY,
			// 한 줄에 하나씩, **그리는 시리즈와 같은 순서**다. 범례가 그 순서를 그대로 보여 준다.
			displayName: t('Units'),
		},
		{ type: 'dropdown', key: SHOW_DOTS_KEY, displayName: t('Show dots'), default: 'auto', options: translateChoices(SHOW_DOTS_CHOICES) },
		{
			type: 'dropdown',
			key: MISSING_VALUES_KEY,
			// 이름이 **무엇에 대한 설정인지**를 말하고 값이 그 처리를 말한다(F1).
			displayName: t('Missing values'),
			default: 'break',
			options: translateChoices(MISSING_VALUES_CHOICES),
		},
		{
			type: 'dropdown',
			key: OPEN_MODE_KEY,
			displayName: t('Open points with'),
			default: DEFAULT_OPEN_MODE,
			options: openModeChoices(),
		},
	] as BasesAllOptions[];
}

export function createPlusGraphRegistration(): BasesViewRegistration {
	return {
		name: t('Plus graph'),
		// 코어 lucide 세트에 있는 선형 차트 글리프다(1.13.6 app.js 실측 — `gantt-chart` 와 같은 등록 형태).
		icon: 'line-chart',
		factory: (controller, containerEl) => new PlusGraphView(controller, containerEl),
		options: () => graphViewOptions(),
	};
}

/** @returns Bases 코어 플러그인이 꺼져 있으면 false. */
export function registerPlusGraphView(plugin: Plugin): boolean {
	return plugin.registerBasesView(PLUS_GRAPH_VIEW_TYPE, createPlusGraphRegistration());
}

export { X_PROPERTY_KEY, X_WINDOW_KEY, UNITS_KEY, SHOW_DOTS_KEY, MISSING_VALUES_KEY, OPEN_MODE_KEY };
