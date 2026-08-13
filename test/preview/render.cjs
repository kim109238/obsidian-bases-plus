'use strict';
/**
 * 화면 실물 검증 — 우리 뷰가 **실제로 만든 DOM** 을 옵시디언 app.css 위에 얹어 렌더한다.
 *
 * 단위 테스트(run.cjs)가 전건 통과해도 눈으로만 잡히는 결함이 있다. 실제로 이 도구로 잡은 것들:
 * 헤더와 본문 열이 344 대 353 으로 어긋남(flex-basis 0 항목의 padding) · 호버 변수가 transparent 라
 * 반응이 안 보임 · 마지막 열 손잡이가 1px 튀어나와 가로 스크롤이 생김.
 *
 * 준비(한 번):
 *   node plugin/test/preview/extract-app-assets.cjs      # 옵시디언 app.css 를 .assets/ 로 (리포에 안 들어감)
 *   npm run build                                        # main.js 가 있어야 한다
 *
 * 사용:
 *   node plugin/test/preview/render.cjs <모드> [옵션]
 *     모드   table(기본) · sized · grouped · paged · ordering · valueOrder · editing · embed · modal · compare
 *     옵션   --dark  --width=900px  --sim(호버·포커스 강제)  --shot[=파일]  --probe  --lang=ko
 *
 * 캡처(--shot)는 `chrome-headless-shell` 빌드로만 된다 — 풀 Chrome for Testing 은 라스터화에서 멈춘다.
 *
 *   예) node plugin/test/preview/render.cjs compare --shot
 *       node plugin/test/preview/render.cjs table --probe        # computed 값 JSON 을 stdout 으로
 *
 * 산출물은 `out/` 에 쌓이고 리포에 들어가지 않는다.
 *
 * 크로미움은 Playwright 캐시에서 찾는다(`~/Library/Caches/ms-playwright/chromium-*`).
 * 없으면 CHROME 환경변수로 실행 파일 경로를 준다.
 */
const Module = require('module');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIR = path.join(__dirname, '..', '..');
const ASSETS_DIR = path.join(__dirname, '.assets');
const OUT_DIR = path.join(__dirname, 'out');
const APP_CSS = path.join(ASSETS_DIR, 'app.css');
const OUR_CSS = path.join(PLUGIN_DIR, 'styles.css');
const BUNDLE = path.join(PLUGIN_DIR, 'main.js');

const stub = require(path.join(PLUGIN_DIR, 'test', 'obsidian-stub.cjs'));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'obsidian') return stub;
	return originalLoad.call(this, request, parent, isMain);
};

const { FakeEl, Modal, Menu } = stub;
global.document = { addEventListener() {}, removeEventListener() {} };

// ── 값 스텁 — 실물 Value 처럼 renderTo 로 그리고 static type 이 값 타입이 된다 ────────────────
class StubValue {
	constructor(render) { this.render = render; }
	renderTo(el) { this.render(el); }
}
class StringValue extends StubValue {}
StringValue.type = 'String';
class NumberValue extends StubValue {}
NumberValue.type = 'Number';
class DateValue extends StubValue {}
DateValue.type = 'Date';
class FileValue extends StubValue {}
FileValue.type = 'File';
class ListValue extends StubValue {}
ListValue.type = 'List';
/** 빈 값 — 실물 NullValue 는 static type 이 "Null" 이고 toString() 이 문자열 "null" 이다. */
class NullValue extends StubValue {}
NullValue.type = 'Null';
class BooleanValue extends StubValue {}
BooleanValue.type = 'Boolean';

// 실물 Value 는 전부 toString() 을 갖는다 — 편집기가 화면 글자가 아니라 값에서 현재 값을 읽으므로 스텁도 같아야 한다.
const text = (t) => Object.assign(new StringValue((el) => el.setText(t)), { toString: () => t });
const num = (n) => Object.assign(new NumberValue((el) => el.setText(String(n))), { toString: () => String(n) });
/** 네이티브 DateValue.renderTo 산출물과 같다 — 비활성 date 입력. */
const date = (v) => Object.assign(
	new DateValue((el) => el.createEl('input', {
		cls: 'metadata-input metadata-input-text mod-date',
		attr: { type: 'date', value: v, step: 'any', disabled: true },
	})),
	// 타임라인은 화면 글자가 아니라 값에서 날짜를 읽는다 — 실물 DateValue 도 toString() 을 갖는다.
	{ toString: () => v }
);
/** 실물 ListValue 처럼 항목을 하나씩 내주고(length·get, 둘 다 공개 API) toString() 은 ", " 로 잇는다. */
const list = (items) =>
	Object.assign(
		new ListValue((el) => {
			const wrap = el.createDiv({ cls: 'value-list-container' });
			items.forEach((item, i) => {
				wrap.createSpan({ cls: 'value-list-element', text: item });
				if (i < items.length - 1) wrap.createSpan({ cls: 'value-list-gap', text: ', ' });
			});
		}),
		{ toString: () => items.join(', '), length: () => items.length, get: (i) => items[i] }
	);
const empty = () => Object.assign(new NullValue(() => {}), { toString: () => 'null' });
/** 실물 BooleanValue 처럼 체크박스 입력으로 그린다. */
const bool = (on) => Object.assign(
  new BooleanValue((el) => el.createEl('input', { cls: 'metadata-input-checkbox', attr: { type: 'checkbox', checked: on, disabled: true } })),
  { toString: () => String(on) }
);
const link = (name) => new FileValue((el) => {
	el.addClass('markdown-rendered');
	el.createSpan({ cls: 'internal-link', text: name, attr: { 'data-href': name } });
});

const PROPS = ['file.name', 'note.status', 'note.due', 'note.priority'];
const DISPLAY = { 'note.매출': '매출', 'note.방문자': '방문자', 'note.날짜': '날짜', 'file.name': 'Name', 'note.status': 'Status', 'note.due': 'Due', 'note.priority': 'Priority', 'note.tags': 'Tags', 'note.시작': 'Start', 'note.종료': 'End' };
const ROWS = [
	['Note A', '진행중1', '2026-08-10', 2],
	['Note B', '대기2', '2026-08-21', 10],
	['Note C with a deliberately long title', '완료', '2026-09-01', 100],
];
/** 타임라인용 시작·종료. 세 번째는 **점 항목**(시작만)이라 다이아몬드 경로까지 한 화면에서 본다. */
const SPANS = [
	['2026-08-04', '2026-08-09'],
	['2026-08-07', '2026-08-08'],
	['2026-08-12', null],
];

/** @param count 목업 행 3개를 되풀이해 늘린다 — 페이징은 행이 여러 페이지로 나뉘어야 보인다. */
function makeEntries(count) {
	const rows = count
		? Array.from({ length: count }, (_, i) => {
				const row = ROWS[i % ROWS.length].slice();
				row[0] = `${row[0]} ${i + 1}`;
				return row;
		  })
		: ROWS;

	return rows.map(([name, status, due, priority], index) => ({
		file: { basename: name, name: `${name}.md`, path: `notes/${name}.md`, extension: 'md' },
		getValue: (prop) => ({
			'file.file': link(name),
			'note.시작': SPANS[index % SPANS.length][0] ? date(SPANS[index % SPANS.length][0]) : empty(),
			'note.종료': SPANS[index % SPANS.length][1] ? date(SPANS[index % SPANS.length][1]) : empty(),
			'note.status': text(status),
			'note.due': date(due),
			'note.priority': num(priority),
			'note.tags': list(['아주 긴 알약 내용이라 칸을 넘긴다', '검수 대기']),
			'note.빈날짜': empty(),
			'note.완료': bool(true),
			'note.빈체크': empty(),
		}[prop] || null),
	}));
}

function makeConfig(stored) {
	const data = Object.assign({}, stored);
	return {
		get: (key) => data[key],
		set: (key, value) => { if (value === null) delete data[key]; else data[key] = value; },
		getDisplayName: (prop) => DISPLAY[prop] || prop,
		getAsPropertyId: (key) => (typeof data[key] === 'string' && data[key] !== '' ? data[key] : null),
	};
}

/** 실물 순서대로 뷰를 세운다 — 팩토리 → config → allProperties·data → onDataUpdated (app.js 2500709·2502560). */
async function mountView(stored, data, viewType, vault) {
	const exported = require(BUNDLE);
	const PluginClass = exported.default || exported;
	const app = {
		renderContext: {},
		vault: {
			getConfig: (k) => (k === 'propertiesInDocument' ? 'visible' : undefined),
			getFileByPath: (path) => (vault ? vault.files[path] || null : null),
			// 달력의 태스크 수집이 읽는 자리(d.ts 공개). 모드가 넘긴 본문을 그대로 돌려준다.
			cachedRead: async (file) => (vault && vault.contents ? vault.contents[file.path] || '' : ''),
			on: () => ({}),
			offref: () => {},
		},
		// 실물과 같은 계약 — 못 찾으면 null 이 아니라 { widget: 'text' } 다(app.js getPropertyInfo).
		metadataTypeManager: {
			getPropertyInfo: (key) => ({
				name: key,
				widget: { 빈날짜: 'date', due: 'date', 시작: 'date', 종료: 'date', priority: 'number', tags: 'tags', status: 'text', 완료: 'checkbox', 빈체크: 'checkbox' }[key] || 'text',
			}),
		},
		fileManager: { async processFrontMatter() {}, async renameFile() {} },
		// 연관 파일이 쓰는 공개 표면. 볼트가 없으므로 모드가 넘긴 최소 링크 그래프를 쓴다.
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file) => (vault ? vault.caches[file?.path] || null : null),
			getFirstLinkpathDest: (link) => (vault ? vault.files['notes/' + link + '.md'] || vault.files[link] || null : null),
			fileToLinktext: (file) => file.basename,
			on: () => ({}),
			offref: () => {},
		},
		workspace: { on: () => ({}), offref: () => {}, trigger: () => {}, getLeaf: () => ({ openFile: async () => {} }) },
	};
	const plugin = new PluginClass(app, { id: 'bases-plus' });
	await plugin.onload();

	const containerEl = new FakeEl('div', 'bases-view');
	containerEl.setAttr('data-view-type', 'bases-plus-table');

	const registration = plugin.basesViews.find((item) => item.id === (viewType || 'bases-plus-table')).registration;
	if (viewType) containerEl.setAttr('data-view-type', viewType);

	const view = registration.factory({ app }, containerEl);
	view.config = makeConfig(stored);
	view.allProperties = PROPS;
	view.data = data;
	view.onDataUpdated();

	return { containerEl, view };
}

/**
 * 타임라인 — 두 판이 한 줄로 묶이는지, 축 최하층 바닥과 열 이름 줄 바닥이 같은 y 인지,
 * 이름이 보이는 구간 왼쪽 + 8px 에 서는지를 **computed 값으로** 본다(명세 J1).
 */
const TIMELINE_PROPS = ['file.name', 'note.status', 'note.시작', 'note.종료'];
const TIMELINE_STORED = { startDate: 'note.시작', endDate: 'note.종료' };

/** 축이 화면보다 넓어지는 데이터. 가로 스크롤이 있어야 확정 7 ⓑ 를 잴 수 있다. */
function wideEntries() {
	const spans = [['2026-06-02', '2026-06-20'], ['2026-08-04', '2026-09-12'], ['2026-10-05', null]];

	return makeEntries().map((entry, index) => {
		const span = spans[index % spans.length];
		const base = entry.getValue;
		entry.getValue = (prop) =>
			prop === 'note.시작'
				? span[0] ? date(span[0]) : empty()
				: prop === 'note.종료'
				? span[1] ? date(span[1]) : empty()
				: base(prop);
		return entry;
	});
}

/**
 * 달력 — 이번 달을 그린다. **오늘이 화면에 있어야** 틴트를 실측할 수 있어서 날짜를 이번 달 기준으로 만든다.
 * 항목은 명세가 요구하는 네 경우를 한 화면에 세운다 — 주 경계를 넘는 여러 날 · 주 안의 여러 날 ·
 * 하루짜리 · `Items per day` 를 넘겨 접히는 칸.
 */
const CALENDAR_PROPS = ['file.name'];
const CALENDAR_STORED = { startDate: 'note.시작', endDate: 'note.종료', itemsPerDay: '3' };

function calDay(day) {
	const now = new Date();
	const pad = (n) => (n < 10 ? `0${n}` : String(n));

	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(day)}`;
}

function calendarEntries() {
	// [이름, 시작일, 종료일] — 4~9 는 반드시 주 경계를 넘고, 20 일에는 다섯이 몰려 +N 이 선다.
	const rows = [
		['1차 계획 완료 하기', 4, 9],
		['기획 시나리오', 12, 13],
		['업무 준비', 10, null],
		['측정 기준 정리', 20, null],
		['코워크 이관', 20, null],
		['릴리스 준비', 20, null],
		['열 구성 검토', 20, null],
		['회고', 20, null],
		['날짜 없는 노트', null, null],
	];

	return rows.map(([name, from, to]) => ({
		file: { basename: name, name: `${name}.md`, path: `notes/${name}.md`, extension: 'md', stat: { mtime: 0 } },
		getValue: (prop) =>
			({
				'file.file': link(name),
				'note.시작': from ? date(calDay(from)) : empty(),
				'note.종료': to ? date(calDay(to)) : empty(),
				'note.status': text('진행중'),
				'note.due': date(calDay(Math.min(28, (to || from || 1) + 2))),
				'note.완료': bool(name.length % 2 === 0),
			}[prop] || null),
	}));
}

/** 태스크가 든 볼트 — 자체 파서 경로(메타데이터 캐시 + 본문 읽기)를 그대로 태운다. */
function calendarVault(entries) {
	const host = entries[0].file;
	const contents = {};
	const caches = {};

	contents[host.path] = [
		'# 업무',
		`- [ ] 측정 기준 정리 📅 ${calDay(14)}`,
		`- [x] 코워크 이관 📅 ${calDay(14)} ✅ ${calDay(14)}`,
		`- [-] 취소된 일 📅 ${calDay(14)} ❌ ${calDay(14)}`,
	].join('\n');
	caches[host.path] = {
		listItems: [
			{ task: ' ', position: { start: { line: 1 } } },
			{ task: 'x', position: { start: { line: 2 } } },
			{ task: '-', position: { start: { line: 3 } } },
		],
	};

	const files = {};
	for (const entry of entries) files[entry.file.path] = entry.file;

	return { files, caches, contents };
}

/** 태스크는 **선수집 후 렌더 2단**이라 한 틱 기다려야 화면에 선다(함정 C). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 320));

async function mountCalendar(stored, properties) {
	const entries = calendarEntries();
	const vault = calendarVault(entries);
	const mounted = await mountView(
		Object.assign({}, CALENDAR_STORED, stored),
		{ data: entries, properties: properties || CALENDAR_PROPS },
		'bases-plus-calendar',
		vault
	);

	await settle();

	return mounted;
}

/**
 * 그래프 — 새로 그리는 것은 플롯 하나라 값도 단순하다. 시리즈 둘에 **한 자리를 비워** 선이 끊기는 구간을
 * 한 화면에 세우고, 툴팁이 걸리는 자리(HTML 점)를 실제 DOM 으로 확인한다.
 */
// 시리즈는 **표시 속성 목록**이 정한다(툴바 Properties) — x 와 숫자가 아닌 속성은 스스로 빠진다.
const GRAPH_PROPS = ['file.name', 'note.날짜', 'note.매출', 'note.방문자'];
const GRAPH_STORED = {
	xProperty: 'note.날짜',
	yUnits: ['만원', '명'],
};
/** 아홉 줄 — 여덟 색을 다 쓰고 아홉째가 첫째 색으로 돌아오는 자리까지 본다(C2). */
const GRAPH_MANY_Y = ['note.y1', 'note.y2', 'note.y3', 'note.y4', 'note.y5', 'note.y6', 'note.y7', 'note.y8', 'note.y9'];
/**
 * 무대 치수 — `--probe` 로 실측한 `.bases-plus-graph-plot` 의 상자다(883 × 209 · 기본 폭 900px 기준).
 * **하네스에는 레이아웃이 없어** 뷰가 재는 값이 0 이 되므로 여기서 심어 준다 — 실물에서는
 * `ResizeObserver` 의 첫 콜백이 같은 일을 한다. 폭 옵션을 바꾸면 이 값도 다시 재야 그림이 맞는다.
 */
const GRAPH_STAGE_PLOT_HEIGHT = 209;

/**
 * 심을 폭은 `--width` 를 따라간다 — 안 그러면 좁은 폭 판정이 넓은 폭 그림을 재게 된다.
 * 무대 테두리 2px 과 뷰의 스크롤바 자리 15px(`scrollbar-gutter: stable`)을 뺀 값이 실측 상자다(900 → 883).
 */
function graphStageWidth() {
	const found = process.argv.find((arg) => arg.startsWith('--width='));
	const px = found ? parseInt(found.slice('--width='.length), 10) : 900;

	return Math.max(120, (Number.isFinite(px) ? px : 900) - 17);
}

function graphEntries(count, seriesCount) {
	const rows = count || 8;
	const out = [];

	for (let i = 0; i < rows; i++) {
		// 달을 넘겨도 실제 날짜여야 한다 — 문자열로 이어 붙이면 `2026-08-32` 같은 값이 만들어져 축이 헝클어진다.
		const at = new Date(2026, 7, 1 + i * (rows > 20 ? 1 : 4));
		const pad = (n) => (n < 10 ? `0${n}` : String(n));
		const name = `Note ${i + 1}`;
		const values = {
			'file.file': link(name),
			'note.날짜': date(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`),
			// 한 자리를 비운다 — 기본값(선 끊기)이 화면에 남는지 보는 자리다(확정 4).
			'note.매출': i === 2 ? empty() : num(40 + i * 13 + (i % 3) * 7),
			'note.방문자': num(70 + ((i * 17) % 40)),
		};

		for (let s = 1; s <= (seriesCount || 0); s++) values[`note.y${s}`] = num(s * 12 + i * (s % 3));

		out.push({
			file: { basename: name, name: `${name}.md`, path: `notes/${name}.md`, extension: 'md', stat: { mtime: 0 } },
			getValue: (prop) => values[prop] || null,
		});
	}

	return out;
}

async function mountGraph(stored, entries, plotHeight, properties) {
	const mounted = await mountView(
		Object.assign({}, GRAPH_STORED, stored),
		{ data: entries || graphEntries(), properties: properties || GRAPH_PROPS },
		'bases-plus-graph'
	);

	const plotEl = mounted.containerEl.find('bases-plus-graph-plot');
	if (plotEl) {
		plotEl.clientWidth = graphStageWidth();
		plotEl.clientHeight = plotHeight || GRAPH_STAGE_PLOT_HEIGHT;
		mounted.view.onDataUpdated();
	}

	return mounted;
}

// ── 모드별 화면 ────────────────────────────────────────────────────────────────────────
const MODES = {
	async table() {
		const entries = makeEntries();
		const { containerEl } = await mountView({}, { data: entries, properties: PROPS });
		return serialize(containerEl);
	},

	/**
	 * 행 7개 · `Row limit: Pages` · `Rows per page: 3` — 표 아래 고정 바에 페이저가 선 상태(I2).
	 * 첫 페이지라 이전 버튼이 `disabled` 다.
	 */
	async paged() {
		const entries = makeEntries(7);
		const { containerEl } = await mountView(
			{ rowLimit: 'pages', pageSize: '3' },
			{ data: entries, properties: PROPS }
		);
		return serialize(containerEl);
	},

	/** 페이지 번호를 누른 상태 — 입력칸이 푸터 위 선을 가리는지 본다(마스터 1차 4번). */
	async pagerEdit() {
		const entries = makeEntries(7);
		const { containerEl } = await mountView(
			{ rowLimit: 'pages', pageSize: '3' },
			{ data: entries, properties: PROPS }
		);
		containerEl.find('bases-plus-pager-page').dispatch('click', { button: 0 });
		return serialize(containerEl);
	},

	/**
	 * 정렬 없음 · `Manual order` 켜짐 — 여백 열과 손잡이가 선 상태(I2).
	 * 드롭 표시자는 실제 드래그 없이는 안 뜨므로 `--sim` 이 강제로 켠다.
	 */
	async ordering() {
		const entries = makeEntries();
		const { containerEl } = await mountView(
			{ manualOrderEnabled: true },
			{ data: entries, properties: PROPS }
		);
		return serialize(containerEl);
	},

	/**
	 * 전 열이 확정 폭이고 **합이 화면보다 넓은** 상태 — 가로 스크롤과 함께, 넘치는 구간에서도 행 구분선·
	 * 테두리가 끝까지 그려지는지 본다. 표가 화면 폭에서 끝나면 오른쪽 열들 사이에 선 없는 빈 띠가 생긴다
	 * (마스터 9차 2번 · 캡처 211651).
	 */
	async sized() {
		const entries = makeEntries();
		const columnSize = { 'file.name': 400, 'note.status': 300, 'note.due': 300, 'note.priority': 200 };
		const { containerEl } = await mountView({ columnSize }, { data: entries, properties: PROPS });
		return serialize(containerEl);
	},

	/**
	 * 편집 중인 셀 — 입력칸이 셀을 꽉 채우는지, 자기 테두리·둥근 모서리·포커스 링을 갖지 않는지 본다.
	 * 코어 `input[type='text']`(app.css:8177 계열)의 명시도가 (0,1,1)이라 한 단짜리 클래스 리셋은 지고,
	 * 그 결과 셀 안에 둥근 입력칸이 겹쳐 보인다(마스터 6차 5·6번). computed 로만 잡히는 종류다.
	 */
	async editing() {
		const entries = makeEntries();
		const properties = PROPS.concat(['note.tags', 'note.빈날짜', 'note.완료', 'note.빈체크', 'formula.calc']);
		const { containerEl } = await mountView({}, { data: entries, properties });
		const rows = containerEl.findAll('bases-plus-row');
		const click = (row, col) =>
			rows[row].findAll('bases-plus-cell')[col].dispatch('click', { target: { closest: () => null }, button: 0 });

		// 텍스트·숫자·목록·빈 날짜를 한 화면에 나란히 편집 상태로 둔다 — 형태 차이가 같이 보이게.
		click(0, 1);
		click(1, 3);
		click(2, 4);
		click(0, 5);

		return serialize(containerEl);
	},

	/**
	 * 접기 화살표·개수·그룹 푸터를 한 화면에 세운다(I2). 한 그룹은 접힌 상태로 두어 화살표 회전과
	 * "행은 지우지 않고 감춘다"를 함께 본다.
	 */
	async grouped() {
		const entries = makeEntries();
		const { containerEl, view } = await mountView(
			{ rowLimit: 'group-top', groupSize: '1', collapsedGroups: ['완료'] },
			{
				data: entries,
				properties: PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: text('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			}
		);
		// 그룹 기준 속성명이 보이도록 config.groupBy 를 세운다(실물에서 코어가 넣어 주는 자리).
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();
		return serialize(containerEl);
	},

	/**
	 * `Group manual order` 만 켠 상태 — 여백 열은 생기되 **그룹 헤딩에만** 손잡이가 뜨는지 본다.
	 * 두 옵션이 독립이라 한쪽만 켰을 때 다른 쪽 손잡이가 함께 사라지는지가 이 화면의 판정 대상이다.
	 */
	async groupOrdering() {
		const entries = makeEntries();
		const { containerEl, view } = await mountView(
			{ groupOrderEnabled: true },
			{
				data: entries,
				properties: PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: text('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			}
		);
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();
		return serialize(containerEl);
	},

	/** 목록값 순서 대화상자 — 확정분 모달 껍데기를 그대로 쓰는지, 줄 높이·잉크 축이 표와 같은지 본다(F3). */
	async valueOrder() {
		const entries = makeEntries();
		const properties = PROPS.concat(['note.tags']);
		const { containerEl } = await mountView({}, { data: entries, properties });

		const headerEl = containerEl.findAll('bases-plus-th')[properties.length - 1];
		headerEl.dispatch('contextmenu', { target: { closest: () => null }, button: 2 });

		const menu = Menu.instances[Menu.instances.length - 1];
		if (!menu || menu.items.length === 0) throw new Error('열 메뉴가 안 떴다 — 목록 타입 판정을 확인하라');
		menu.items[0].click();

		const modal = Modal.instances[Modal.instances.length - 1];
		if (!modal) throw new Error('값 순서 대화상자가 안 열렸다');

		// 닫기 X 는 코어가 그리는 요소다 — 스텁이 클래스만 만들어 두므로 아이콘 자리를 채워 박스 치수를 맞춘다.
		modal.closeButtonEl.createSpan({ cls: 'mock-close-icon' });

		return serialize(modal.containerEl);
	},

	/** 모달 — 코어 닫기 X 와 우리 버튼이 겹치지 않는지 본다. */
	async modal() {
		const entries = makeEntries();
		entries[0].file = { basename: 'Demo', name: 'Demo.base', path: 'Demo.base', extension: 'base' };
		const { containerEl } = await mountView({}, { data: [entries[0]], properties: PROPS });

		containerEl.find('bases-plus-cell').dispatch('click', { target: { closest: () => ({}) }, button: 0 });
		await new Promise((resolve) => setImmediate(resolve));

		const modal = Modal.instances[Modal.instances.length - 1];
		if (!modal) throw new Error('모달이 안 열렸다 — 열기 경로를 확인하라');

		// 닫기 버튼은 스텁이 이미 코어와 같은 클래스로 만든다 — 여기서는 아이콘 자리(--icon-m)만 채워
		// 실물과 같은 26×26 박스가 되게 한다. 비워 두면 폭이 0 이라 위치 검수가 헛돈다.
		modal.closeButtonEl.createSpan({ cls: 'mock-close-icon' });
		const leafEl = modal.contentEl.find('bases-plus-modal-leaf');
		if (leafEl) leafEl.createDiv({ cls: 'mock-editor', text: '(노트 편집기 자리)' });

		return serialize(modal.containerEl);
	},

	/**
	 * 노트 안 임베드(```base 코드블록) 경로. 코어는 마크다운 뷰 안의 `.bases-view` 에만 바깥 테두리를 걸고
	 * 그 굵기는 뷰 종류별 변수로 켠다(app.css:14325·15351) — 탭에서는 멀쩡한데 임베드에서만 테두리가
	 * 없던 결함이 이 경로에서만 보인다. 네이티브 표 임베드와 나란히 놓는다.
	 */
	async embed() {
		const entries = makeEntries();
		const { containerEl } = await mountView({}, { data: entries, properties: PROPS });

		return `<div class="lab">NATIVE 임베드</div>` +
			`<div class="block-language-base">${nativeMock()}</div>` +
			`<div class="lab">OURS 임베드</div>` +
			`<div class="block-language-base">${serialize(containerEl)}</div>`;
	},

	/**
	 * 달력 월 보기 — 7열 그리드 · 오늘 틴트 · 주 경계를 넘는 막대 · `+N` 접힘 · 태스크가 한 화면에 선다.
	 */
	async calendar() {
		const { containerEl } = await mountCalendar({ showTasks: true });
		return serialize(containerEl);
	},

	/** 속성·색을 끈 기본 칩 — 마스터 2차 8번("기본값도 배경색이 거의 없었으면")의 기준 화면이다. */
	async calendarPlain() {
		const { containerEl } = await mountCalendar({}, ['file.name']);
		return serialize(containerEl);
	},

	/** `+N` 을 누른 상태 — 그 줄만 늘고 되접는 단추가 같은 자리에 남는지 본다(확정 2). */
	async calendarExpanded() {
		const { containerEl } = await mountCalendar({ showTasks: true });
		const more = containerEl
			.findAll('bases-plus-cal-more')
			.filter((el) => !el.hidden)[0];
		if (more) more.dispatch('click');

		return serialize(containerEl);
	},

	/** 주 보기 — 한 줄이라 임베드에 들어간다. 칸이 세로로 길어지는지 본다(A3). */
	async calendarWeek() {
		const { containerEl } = await mountCalendar({ showTasks: true, calendarView: 'week' });
		return serialize(containerEl);
	},

	/**
	 * 칸 상태 겹침 — **주말이면서 오늘**인 날은 한 해에 100 번쯤 온다. 오늘이 평일인 날 돌려도 규칙을
	 * 재려면 그 조합을 만들어야 해서, 오늘 칸에 주말 표식을 얹어 **어느 배경이 이기는지**를 computed 로 본다.
	 * 속성 줄(C2)도 이 모드에서 함께 잰다.
	 */
	async calendarStates() {
		const { containerEl } = await mountCalendar(
			{
				showTasks: true,
				checkboxProperty: 'note.완료',
				listProperty: 'note.status',
				colorBy: 'note.status',
				showEmptyProperties: true,
			},
			['file.name', 'note.tags', 'note.status', 'note.완료', 'note.due', 'note.priority']
		);
		const today = containerEl.findAll('bases-plus-cal-day').filter((el) => el.hasClass('is-today'))[0];
		if (today) today.addClass('is-weekend');
		// `Wrap item text` 는 클래스 하나로 갈리는 규칙이라 살아 있는지 computed 로 본다(같은 화면에서 함께 잰다).
		containerEl.find('bases-plus-calendar').addClass('is-wrap');

		return serialize(containerEl);
	},

	/** 년·월 선택 창(1차 요청) — 월 12칸과 년 이동이 코어 어휘로 서는지 본다. */
	async calendarPicker() {
		const { containerEl } = await mountCalendar({});
		containerEl.find('bases-plus-cal-period').dispatch('click');
		const modal = Modal.instances[Modal.instances.length - 1];

		return `<div class="modal-container mod-dim"><div class="modal-bg"></div>${serialize(modal.modalEl)}</div>`;
	},

	/**
	 * 임베드 — 사용자가 높이를 낮게 준 경우다. 달력은 네 뷰 중 **임베드에서 잘릴 수 있는 유일한 뷰**라
	 * 그 상황에서 안내 띠가 서는지, 우리가 세로 스크롤을 만들지 않았는지 본다(A4).
	 */
	async calendarEmbed() {
		const { containerEl } = await mountCalendar({});

		return `<div class="lab">임베드 — 높이 260px</div>` +
			`<div class="block-language-base"><div class="bases-embed" style="height:260px">${serialize(containerEl)}</div></div>`;
	},

	/** 타임라인 기본 화면 — 축 3층 · 기간 막대 둘 · 점 항목 하나 · 오늘 틴트가 한 화면에 선다. */
	async timeline() {
		const entries = makeEntries();
		const { containerEl } = await mountView(
			TIMELINE_STORED,
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);
		return serialize(containerEl);
	},

	/**
	 * 축이 화면보다 넓은 상태 — **가로 스크롤이 있어야** 확정 7 ⓑ(이름이 보이는 구간 왼쪽에 붙는다)를 잴 수 있다.
	 * 기본 `timeline` 모드는 데이터가 두 주뿐이라 축이 화면 안에 다 들어와 스크롤이 0 이다.
	 */
	async timelineWide() {
		const entries = wideEntries();
		const { containerEl } = await mountView(
			TIMELINE_STORED,
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);
		return serialize(containerEl);
	},

	/**
	 * 가로로 스크롤한 상태(확정 7 ⓑ) — 막대 왼쪽이 왼쪽 판 밑으로 들어간 순간의 이름 자리를 본다.
	 * 스크롤 갱신은 뷰의 실제 리스너로 돌린다(하네스와 같은 경로) — 그 결과가 직렬화돼 넘어간다.
	 */
	async timelineScrolled() {
		const entries = wideEntries();
		const { containerEl } = await mountView(
			TIMELINE_STORED,
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);

		const scrollEl = containerEl.find('bases-plus-timeline');
		scrollEl.scrollLeft = 400;
		scrollEl.clientWidth = 883;
		scrollEl.dispatch('scroll');
		// 페이지가 같은 자리로 스크롤해야 계산 좌표와 실제 레이아웃을 나란히 놓을 수 있다.
		scrollEl.setAttr('data-scroll-left', '400');

		return serialize(containerEl);
	},

	/**
	 * 그룹 + 가로 스크롤 — 헤딩 글자가 **왼쪽에 남는지**를 실제 레이아웃에서 본다(마스터 1차 27번).
	 * 선언만 보면 `sticky` 라 통과하는데, `overflow: hidden` 이 스크롤 컨테이너를 만들어 죽어 있었다.
	 */
	async timelineScrolledGroup() {
		const entries = wideEntries();
		const { containerEl, view } = await mountView(
			TIMELINE_STORED,
			{
				data: entries,
				properties: TIMELINE_PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: text('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			},
			'bases-plus-timeline'
		);
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();

		const scrollEl = containerEl.find('bases-plus-timeline');
		scrollEl.scrollLeft = 400;
		scrollEl.clientWidth = 883;
		scrollEl.dispatch('scroll');
		scrollEl.setAttr('data-scroll-left', '400');

		return serialize(containerEl);
	},

	/**
	 * 회귀 재현판 — 행이 많고 · 그룹 기준이 걸려 있고 · **그룹 순서만 켜진** 상태(행에는 손잡이가 없어
	 * 여백 열이 비는 조건 · 5차 요청). 행과 트랙의 짝, 여백 열 자리채움을 함께 본다.
	 */
	async timelineRegression() {
		const entries = makeEntries(24);
		const { containerEl, view } = await mountView(
			Object.assign({ groupOrderEnabled: true }, TIMELINE_STORED),
			{
				data: entries,
				properties: TIMELINE_PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: entries.filter((_, i) => i % 3 === 0) },
					{ key: text('대기'), hasKey: () => true, entries: entries.filter((_, i) => i % 3 === 1) },
					{ key: text('완료'), hasKey: () => true, entries: entries.filter((_, i) => i % 3 === 2) },
				],
			},
			'bases-plus-timeline'
		);
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();
		// 되풀이 갱신으로 요소 풀이 어긋날 기회를 준다.
		view.onDataUpdated();
		view.onDataUpdated();

		return serialize(containerEl);
	},

	/**
	 * 그룹 수동 순서 — 헤딩 손잡이가 선 평상시 모습(마스터 2차 요청). `--sim` 이 손잡이를 드러내고
	 * 드래그 중 상태(`is-being-dragged`)도 함께 세워 두 장면을 한 화면에서 잰다.
	 */
	async timelineGroupOrder() {
		const entries = makeEntries();
		const { containerEl, view } = await mountView(
			Object.assign({ groupOrderEnabled: true }, TIMELINE_STORED),
			{
				data: entries,
				properties: TIMELINE_PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: text('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			},
			'bases-plus-timeline'
		);
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();

		// 둘째 헤딩을 끌고 있는 상태로 둔다 — 드래그 중 고스트의 배경·폭이 이 라운드의 판정 대상이다.
		const headings = containerEl.findAll('bases-plus-group-heading').filter((el) => !el.hidden);
		if (headings[1]) headings[1].addClass('is-being-dragged');

		return serialize(containerEl);
	},

	/**
	 * 주 배율 — 40px 칸에 `8월 3일` 이 들어가지 않아 시작일 라벨이 겹쳤다(마스터 1차 15번).
	 * 좁은 칸에서는 글자를 솎아 내 겹침을 없앤다. `--mode` 로 넓은 단계(`week-wide`)도 함께 본다.
	 */
	async timelineWeek() {
		const entries = wideEntries();
		const { containerEl } = await mountView(
			Object.assign({ timelineUnit: 'week' }, TIMELINE_STORED),
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);
		return serialize(containerEl);
	},

	async timelineWeekWide() {
		const entries = wideEntries();
		const { containerEl } = await mountView(
			Object.assign({ timelineUnit: 'week-wide' }, TIMELINE_STORED),
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);
		return serialize(containerEl);
	},

	/**
	 * 화면이 데이터보다 넓을 때 — 축이 **화면 끝까지** 가는지 본다(마스터 1차 요청 3번).
	 * 임베드는 폭이 좁아 늘 넘쳤고, base 를 직접 열었을 때만 오른쪽에 격자도 행 선도 없는 띠가 남았다.
	 * Node 에는 레이아웃이 없어 뷰가 화면 폭을 모른다 — 실물처럼 폭을 심어 다시 그린다.
	 *
	 * 같이 쓰기: `node test/preview/render.cjs timelineFill --width=1400px --shot`
	 */
	async timelineFill() {
		const entries = makeEntries();
		const { containerEl, view } = await mountView(
			TIMELINE_STORED,
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);

		containerEl.find('bases-plus-timeline').clientWidth = 1400;
		view.onDataUpdated();

		return serialize(containerEl);
	},

	/**
	 * 수동 순서 + 가로 스크롤 — 여백 열이 **스크롤에도 남는지** 본다(마스터 1차 31번).
	 * 예전에는 줄의 왼쪽 여백이라 16px 만 흘러 나가 손잡이가 사라지고 표의 선이 끊어져 보였다.
	 */
	async timelineOrdering() {
		const entries = wideEntries();
		const { containerEl } = await mountView(
			Object.assign({ manualOrderEnabled: true }, TIMELINE_STORED),
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);

		const scrollEl = containerEl.find('bases-plus-timeline');
		scrollEl.scrollLeft = 400;
		scrollEl.clientWidth = 883;
		scrollEl.dispatch('scroll');
		scrollEl.setAttr('data-scroll-left', '400');

		return serialize(containerEl);
	},

	/**
	 * 색 대화상자 — 스와치가 실제로 **색으로 칠해지는지** 본다. 모달은 코어가 `body` 직속으로 그려
	 * 우리 뷰 바깥에 서므로, 팔레트 변수를 뷰에만 정의하면 여기서 빈 네모가 된다(마스터 1차 21번).
	 */
	async timelineColorModal() {
		const entries = makeEntries();
		const { containerEl } = await mountView(
			Object.assign({ colorBy: 'note.status' }, TIMELINE_STORED),
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);

		const toolEls = containerEl.findAll('bases-plus-tl-tool');
		toolEls[3].dispatch('click', { button: 0 });

		const modal = Modal.instances[Modal.instances.length - 1];
		if (!modal) throw new Error('색 대화상자가 안 열렸다');
		modal.closeButtonEl.createSpan({ cls: 'mock-close-icon' });

		return serialize(modal.containerEl);
	},

	/** 색을 켠 화면(확정 8) — 채움 20% + 왼쪽 3px 띠, 글자가 본문색이라 어느 색에서도 읽힌다. */
	async timelineColor() {
		const entries = makeEntries();
		const { containerEl } = await mountView(
			Object.assign({ colorBy: 'note.status' }, TIMELINE_STORED),
			{ data: entries, properties: TIMELINE_PROPS },
			'bases-plus-timeline'
		);
		return serialize(containerEl);
	},

	/** 그룹 + 항목 추가 `+` 가 함께 선 화면. 헤딩 글자가 sticky 인지도 여기서 본다(E1). */
	async timelineGrouped() {
		const entries = makeEntries();
		const { containerEl, view } = await mountView(
			TIMELINE_STORED,
			{
				data: entries,
				properties: TIMELINE_PROPS,
				groupedData: [
					{ key: text('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: text('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			},
			'bases-plus-timeline'
		);
		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.onDataUpdated();
		return serialize(containerEl);
	},

	/** 네이티브 표 구조를 그대로 재현해 우리 표와 위아래로 놓는다 — 테두리·치수 대조용. */
	/** 그래프 — 목업 01 과 같은 구성(시리즈 둘 · x 는 날짜 · 값 없는 구간에서 선이 끊긴다). */
	async graph() {
		const { containerEl } = await mountGraph({});
		return serialize(containerEl);
	},

	/** 점이 뭉치는 밀도 — `Auto` 가 솎고 선만 남기는지, 선이 모든 값을 지나는지 본다(확정 3). */
	async graphDense() {
		const { containerEl } = await mountGraph({}, graphEntries(400));
		return serialize(containerEl);
	},

	/** 시리즈 아홉 — 아홉째가 첫째와 같은 색에 파선인지 본다(C2·H). */
	async graphSeries() {
		const { containerEl } = await mountGraph(
			{ yUnits: [] },
			graphEntries(6, GRAPH_MANY_Y.length),
			null,
			['note.날짜'].concat(GRAPH_MANY_Y)
		);
		return serialize(containerEl);
	},

	/**
	 * 노트 임베드 — 높이가 auto 라 백분율이 풀리고 플롯의 `min-height`(180px)가 그 자리를 대신한다(A3).
	 * 임베드는 `overflow: hidden` 이라 우리가 만든 높이가 잘리면 그대로 사라진다.
	 */
	async graphEmbed() {
		// 임베드에서는 플롯이 `min-height` 180px 로 선다 — 무대와 다른 상자라 그 값으로 심는다.
		const { containerEl } = await mountGraph({}, graphEntries(6), 180);
		return `<div class="lab">OURS 임베드</div><div class="block-language-base bases-embed">${serialize(containerEl)}</div>`;
	},

	/**
	 * x 창 — 석 달치에서 30일 창을 잡은 상태. 띠(네이티브 가로 스크롤바)가 서고 손잡이가 전체의 3분의 1쯤
	 * 되는지, 선이 창 경계에서 잘리는지 본다. 스크롤 자리는 오른쪽 끝(최근)이다.
	 */
	async graphWindow() {
		const { containerEl, view } = await mountGraph({ xWindow: '30' }, graphEntries(90));
		const rail = containerEl.find('bases-plus-graph-rail');
		const track = containerEl.find('bases-plus-graph-rail-track');

		// 브라우저가 할 일(스타일 폭 → 실제 폭)을 대신 심고 다시 그린다 — 그래야 스크롤 자리가 계산된다.
		rail.clientWidth = graphStageWidth() - 36 - 8;
		track.offsetWidth = Math.round(parseFloat(track.style.width || '0'));
		view.onDataUpdated();
		track.offsetWidth = Math.round(parseFloat(track.style.width || '0'));
		// 정적 페이지에는 스크롤 위치가 없다 — probe 스크립트가 되살리는 자리에 적어 둔다.
		rail.setAttr('data-scroll-left', String(Math.max(0, track.offsetWidth - rail.clientWidth)));

		return serialize(containerEl);
	},

	/** 범례를 눌러 첫 시리즈를 감춘 상태 — 줄이 자리를 지키고 흐려지는지, 축이 비켜 주는지 본다. */
	async graphLegendOff() {
		const { containerEl } = await mountGraph({});
		containerEl.find('bases-plus-graph-legend-item').dispatch('click');
		return serialize(containerEl);
	},

	/** x 미지정 — 빈 좌표축 없이 안내 띠만 서는지 본다(D). */
	async graphEmpty() {
		const { containerEl } = await mountGraph({ xProperty: null }, null, null, []);
		return serialize(containerEl);
	},

	async compare() {
		return `<div class="lab">NATIVE (구조·좌표 재현)</div><div class="view-content stage">${nativeMock()}</div>` +
			`<div class="lab">OURS</div><div class="view-content stage">${await MODES.table()}</div>`;
	},
};

/**
 * 네이티브 표 목업. 네이티브는 `.bases-tr`·`.bases-td` 가 position:absolute 라 가상 스크롤러가 넣어 주는
 * 좌표가 있어야 선다 — 그 좌표를 직접 박아 실제 화면과 같은 결과를 만든다(app.css:15398·15615·15626).
 */
function nativeMock() {
	const widths = [353, 177, 177, 176];
	const xs = [];
	widths.reduce((acc, w) => (xs.push(acc), acc + w), 0);
	const total = widths.reduce((a, b) => a + b, 0);

	const head = widths.map((w, i) =>
		`<div class="bases-td" style="inset-inline-start:${xs[i]}px;width:${w}px">` +
		`<div class="bases-table-header"><div class="bases-table-header-label">` +
		// 네이티브 헤더도 라벨 안에 유형 아이콘을 둔다 — 빼면 우리 쪽에만 아이콘이 있는 것처럼 보인다.
		`<div class="bases-table-header-icon"></div>` +
		`<div class="bases-table-header-name">${DISPLAY[PROPS[i]]}</div></div></div>` +
		`<div class="bases-table-header-resizer"></div></div>`
	).join('');

	const body = ROWS.map((row, r) =>
		`<div class="bases-tr" style="top:${r * 30}px;width:${total}px">` +
		row.map((cell, i) =>
			`<div class="bases-td" style="inset-inline-start:${xs[i]}px;width:${widths[i]}px">` +
			`<div class="bases-table-cell"><div class="bases-rendered-value">${
				i === 0 ? `<span class="internal-link">${cell}</span>` : cell
			}</div></div></div>`
		).join('') + `</div>`
	).join('');

	return `<div class="bases-view" data-view-type="table"><div class="bases-table-container">` +
		`<div class="bases-table" style="width:${total}px;height:${(ROWS.length + 1) * 30}px">` +
		`<div class="bases-thead">${head}</div>` +
		`<div class="bases-tbody" style="height:${ROWS.length * 30}px">${body}</div>` +
		`</div></div></div>`;
}

// ── 페이지 조립 ────────────────────────────────────────────────────────────────────────
/** 로드 순서(app.css → styles.css)를 실제와 같게 둔다 — 같은 명시도의 규칙 다툼이 재현돼야 한다. */
function buildPage(bodyHtml, opts) {
	const modalModes = opts.mode === 'modal' || opts.mode === 'valueOrder' || opts.mode === 'timelineColorModal' || opts.mode === 'calendarPicker';
	const stage = opts.mode === 'compare' || modalModes || opts.mode === 'embed' ? '' :
		`<div class="view-content stage">${bodyHtml}</div>`;
	const inner = stage || bodyHtml;

	return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.relative(OUT_DIR, APP_CSS)}">
<link rel="stylesheet" href="${path.relative(OUT_DIR, OUR_CSS)}">
<style>
  html, body { margin: 0; height: 100%; }
  .stage { width: ${opts.width}; height: ${opts.mode.startsWith('calendar') ? 'auto' : '260px'}; display: flex; flex-direction: column; border: 1px solid #888; }
  .lab { font: 12px system-ui; padding: 4px 8px; color: #666; }
  .block-language-base { width: ${opts.width}; margin: 0 8px 12px; }
  /* 네이티브 목업은 position:absolute 라 부모 높이가 없으면 접힌다 — 무대에서만 높이를 준다. */
  .block-language-base .bases-view[data-view-type="table"] { height: 122px; }
  .mock-editor { padding: 12px; color: #888; background: var(--background-secondary); height: 100%; }
  /* 코어는 여기에 lucide 아이콘 svg 를 넣는다 — 헤드리스에선 같은 크기의 자리만 채워 박스 치수를 맞춘다. */
  .mock-close-icon { display: block; width: var(--icon-m); height: var(--icon-m); }
  /* 스텁 setIcon 은 no-op 이라 아이콘 자리가 0px 이 된다 — 실물 svg 와 같은 폭의 덩어리로 자리를 잡아 준다. */
  .bases-plus-th-icon:empty:after, .bases-table-header-icon:empty:after, .multi-select-pill-remove-button:empty:after {
    content: ""; display: block; width: var(--icon-size); height: var(--icon-size);
    background: currentColor; opacity: 0.4; border-radius: 2px;
  }
  /*
   * 우리가 주입한 svg 는 코어 규칙으로 크기를 얻지만 path 가 없어 아무것도 안 보인다 —
   * 위 filler 와 같은 덩어리로 칠해 네이티브 목업과 나란히 놓았을 때 자리 비교가 성립하게 한다.
   */
  svg.svg-icon:empty { background: currentColor; opacity: 0.4; border-radius: 2px; }
  .mock-close-icon:after { content: "✕"; font-size: 14px; line-height: var(--icon-m); }
  #probe { display: none; }
  /* 순서 모드 손잡이는 평시 opacity 0 이다 — 헤드리스에서 호버를 못 만드니 강제로 드러낸다. */
  .sim .bases-plus-order-handle > svg { opacity: 1; }
  /*
   * 그룹 헤딩의 + 도 호버 전용이다. 우리 규칙에서 :hover 만 뗀 같은 셀렉터를 걸어야 의미가 있다 —
   * 결합자까지 그대로 베껴야 자식/자손이 바뀌었을 때 여기서 잡힌다(3차 2번이 그 종류였다).
   */
  .sim .bases-plus-group-heading .bases-plus-group-add { opacity: 1; }
  /*
   * 헤딩 호버 배경 — `+` 를 보려면 호버해야 하므로 **정박 상자·손잡이의 색은 늘 이 상태에서 봐야 한다**.
   * 우리 규칙에서 :hover 만 뗀 같은 선언을 걸어 실물과 같은 조건을 만든다(5차 2·3번).
   */
  .sim .bases-plus-group-heading.is-collapsible { background-color: var(--bases-table-header-background-hover); }
  /* 드롭 표시자는 실제 드래그 중에만 켜진다 — 첫 행 아래 경계에 세워 두께·색을 본다. */
  .sim .bases-plus-drop-indicator { display: block; top: 60px; }
  /* 헤드리스에선 실제 hover·focus 를 못 만든다 — 같은 선언을 강제로 입혀 대비를 본다. */
  .sim .bases-plus-rows .bases-plus-row:nth-child(2) { background-color: var(--background-modifier-hover); }
  .sim .bases-plus-rows .bases-plus-row:nth-child(3) { outline: var(--border-width) solid var(--interactive-accent); outline-offset: calc(var(--border-width) * -1); }
  .sim .bases-plus-th:nth-child(1) .bases-plus-th-resizer { background-color: var(--divider-color-hover); }
  .sim .bases-plus-th:nth-child(2) .bases-plus-th-resizer { background-color: var(--color-accent); }
  /*
   * 셀 호버 — 하단 구분선이 배경에 먹히는지 본다(7차 5번). 실제 :hover 선언과 같은 값이고,
   * 첫 행 둘째 열에만 건다(다른 행에는 위의 legacy sim 이 걸려 있어 판정이 섞인다).
   */
  .sim .bases-plus-row:nth-child(1) .bases-plus-cell:nth-child(2) { background-color: var(--background-modifier-hover); }
  /* 커서 검증 — 헤드리스는 :hover 를 못 만든다. 우리 규칙에서 :hover 만 뗀 같은 선언을 걸어 승패를 본다. */
  .sim .bases-plus-cell.is-typing:not(.is-editing) { cursor: text; }
  /* 빈 날짜 플레이스홀더의 호버 노출 — 네이티브처럼 평시 opacity:0, 호버에서 1 이다(8차 2번). */
  .sim .bases-plus-row:nth-child(2) .bases-plus-empty-date { opacity: 1; }
  /* 달력의 추가 버튼도 호버 전용이다 — 날짜 옆 자리와 크기를 보려면 드러내야 한다(1차 19번). */
  .sim .bases-plus-cal-add { opacity: 1; }
  /* 같은 항목의 조각 하이라이트는 pointerenter 로만 켜진다 — 첫 항목에 강제로 걸어 대비를 본다. */
  .sim .bases-plus-cal-week:nth-child(2) .bases-plus-cal-slot .bases-plus-cal-item { background-color: var(--interactive-accent-hover); }
  /*
   * 점 호버(반지름 3 → 5)는 헤드리스에서 못 만든다 — 우리 규칙에서 :hover 만 뗀 같은 선언을 둘째 점에 걸어
   * 커진 상자를 잰다. 상자는 반지름 × 2 + 테두리 라 3 → 7.5px · 5 → 11.5px 이 기대값이다(C1).
   */
  .sim .bases-plus-graph-dot:nth-child(2) { --bases-plus-graph-dot-radius: 5px; z-index: 1; }
</style></head>
<body class="${opts.dark ? 'theme-dark' : 'theme-light'} mod-macos is-focused${opts.sim ? ' sim' : ''}">
<div class="app-container"><div class="workspace"><div class="workspace-leaf">
<div class="workspace-leaf-content" data-type="${opts.mode === 'embed' ? 'markdown' : 'bases'}">${inner}</div>
</div></div></div>
<pre id="probe"></pre>
<script>${PROBE_SCRIPT}</script>
</body></html>`;
}

/** 페이지 안에서 계산해 회수하는 값들 — 선언이 살아 있는지, 열이 맞는지는 computed 로만 확인된다. */
const PROBE_SCRIPT = `
(function () {
  // 직렬화된 스크롤 위치를 되살린다 — 그 상태로 계산된 이름 좌표와 실제 레이아웃을 나란히 놓기 위해서다.
  document.querySelectorAll('[data-scroll-left]').forEach(function (el) {
    el.scrollLeft = Number(el.getAttribute('data-scroll-left')) || 0;
  });
  const css = (sel, props) => {
    const el = document.querySelector(sel);
    if (!el) return 'MISSING';
    const s = getComputedStyle(el);
    const out = {};
    props.forEach((p) => { out[p] = s.getPropertyValue(p); });
    return out;
  };
  const widths = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => Math.round(el.getBoundingClientRect().width));
  const view = document.querySelector('.bases-view');
  // 행 상자가 **내용 폭 전체**를 덮어야 한다 — 화면 폭에서 끝나면 넘치는 구간에 구분선이 안 그려진다(9차 2번).
  const rowEl = document.querySelector('.bases-plus-row');
  const tableEl = document.querySelector('.bases-plus-table');
  const columnsTotal = Array.from(document.querySelectorAll('.bases-plus-thead .bases-plus-th'))
    .reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
  const result = {
    rowSpansContent: rowEl && tableEl
      ? {
          rowWidth: Math.round(rowEl.getBoundingClientRect().width),
          tableWidth: Math.round(tableEl.getBoundingClientRect().width),
          columnsTotal: Math.round(columnsTotal),
          covered: Math.round(rowEl.getBoundingClientRect().width) >= Math.round(columnsTotal) - 1,
        }
      : null,
    thead: css('.bases-plus-thead', ['position', 'height', 'background-color', 'box-shadow']),
    row: css('.bases-plus-row', ['height', 'box-shadow', 'cursor']),
    cell: css('.bases-plus-cell', ['flex', 'box-shadow', 'overflow']),
    rows: css('.bases-plus-rows', ['box-shadow', 'background-color']),
    value: css('.bases-plus-value', ['padding', 'font-size', 'text-overflow']),
    headerWidths: widths('.bases-plus-th'),
    // :first-of-type 은 쓸 수 없다 — 행 컨테이너의 첫 div 가 드롭 표시자라 아무것도 안 잡힌다.
    firstRowCellWidths: rowEl
      ? Array.from(rowEl.querySelectorAll('.bases-plus-cell')).map((el) => Math.round(el.getBoundingClientRect().width))
      : [],
    scroll: view ? { scrollWidth: view.scrollWidth, clientWidth: view.clientWidth } : null,
  };
  const nativeCell = document.querySelector('.bases-td');
  if (nativeCell) {
    result.nativeCell = css('.bases-td', ['box-shadow']);
    result.nativeTbody = css('.bases-tbody', ['box-shadow']);
    result.nativeThead = css('.bases-thead', ['box-shadow', 'height']);
    result.nativeRow = css('.bases-tr', ['box-shadow', 'height']);
  }
  const embeds = document.querySelectorAll('.block-language-base .bases-view');
  if (embeds.length) {
    result.embed = Array.from(embeds).map((el) => {
      const s = getComputedStyle(el);
      return { viewType: el.dataset.viewType || '', borderWidth: s.borderWidth, borderColor: s.borderColor, padding: s.padding };
    });
  }
  // 편집 중인 입력칸 — 셀을 꽉 채우는 평면인지(자기 테두리·모서리·포커스 링이 없는지) computed 로 본다.
  const input = document.querySelector('.bases-plus-cell-input');
  if (input) {
    const editingCell = input.closest('.bases-plus-cell');
    const cellBox = editingCell.getBoundingClientRect();
    const box = input.getBoundingClientRect();
    // 편집 전후로 글자가 튀지 않아야 한다 — 안 고치는 다른 행의 같은 열 값과 글자 시작 x·글꼴을 맞춰 본다.
    const rowsForRest = Array.from(document.querySelectorAll('.bases-plus-row')).filter((e) => e.offsetParent !== null);
    const restingRow = rowsForRest[rowsForRest.length - 1];
    const restingValue = restingRow && restingRow.querySelector('.bases-plus-cell:nth-child(2) .bases-plus-value');
    const numberInput = document.querySelector('.bases-plus-cell-input[type="number"]');
    // 포커스 링은 실제로 포커스를 줘야 계산된다 — 코어 input[type=text]:focus (0,2,1)를 이기는지가 이 값이다.
    input.focus();
    result.input = {
      text: css('.bases-plus-cell-input', ['border-radius', 'border-width', 'height', 'background-color', 'padding', 'text-align', 'font-size']),
      spansCellWidth: Math.round(cellBox.right - box.right) + Math.round(box.left - cellBox.left),
      textStartGap: restingValue
        ? Math.round(box.left + parseFloat(getComputedStyle(input).paddingLeft)) -
          Math.round(restingValue.getBoundingClientRect().left + parseFloat(getComputedStyle(restingValue).paddingLeft))
        : null,
      fontMatchesValue: restingValue
        ? getComputedStyle(input).fontSize === getComputedStyle(restingValue).fontSize
        : null,
      // 헤드리스 --dump-dom 은 문서에 포커스가 없어 :focus 가 매칭되지 않는다(항상 false).
      // 포커스 링은 이 도구로 못 잰다 — 명시도 계산으로 판정하고 여기서는 그 사실만 남긴다.
      focusMeasurable: input.matches(':focus'),
      number: numberInput ? { textAlign: getComputedStyle(numberInput).textAlign, borderRadius: getComputedStyle(numberInput).borderRadius } : null,
    };

    // 목록 편집기는 행 높이(30px) 안에 들어와야 한다 — 넘치면 아래 행을 덮는다.
    const pill = document.querySelector('.bases-plus-cell .multi-select-pill');
    if (pill) {
      const listCell = pill.closest('.bases-plus-cell').getBoundingClientRect();
      result.listEditor = {
        pillHeight: Math.round(pill.getBoundingClientRect().height),
        containerHeight: Math.round(pill.parentElement.getBoundingClientRect().height),
        cellHeight: Math.round(listCell.height),
        overflowsRow: Math.round(pill.parentElement.getBoundingClientRect().height) > Math.round(listCell.height),
      };
    }
  }

  // 빈 날짜 플레이스홀더 — 평시에는 숨고(opacity 0) 셀 안에 머물러야 한다.
  const emptyDate = document.querySelector('.bases-plus-empty-date');
  if (emptyDate) {
    const cell = emptyDate.closest('.bases-plus-cell').getBoundingClientRect();
    const box = emptyDate.getBoundingClientRect();
    result.emptyDate = {
      opacity: getComputedStyle(emptyDate).opacity,
      disabled: emptyDate.disabled,
      withinCell: box.left >= cell.left - 0.5 && box.right <= cell.right + 0.5,
    };
  }

  // 알약 칸의 내용 폭 측정 — 값 요소의 scrollWidth 만 보면 안쪽 스크롤 컨테이너에서 넘침이 끊긴다(9차 3번).
  const chips = document.querySelector('.bases-plus-chips');
  if (chips) {
    const valueEl = chips.parentElement;
    result.chipMeasure = {
      naive: valueEl.scrollWidth,
      childAware: chips.scrollWidth + (valueEl.clientWidth - chips.clientWidth),
      chipsScrollWidth: chips.scrollWidth,
      chipsClientWidth: chips.clientWidth,
      chipsOverflows: chips.scrollWidth > chips.clientWidth,
    };
  }

  // 알약 칸의 상시 입력칸 — 셀 배경과 어긋나면 흰 네모로 뜬다(10차 1번).
  const chipInput = document.querySelector('.bases-plus-chip-input');
  if (chipInput) {
    const cs = getComputedStyle(chipInput);
    result.chipInput = {
      backgroundColor: cs.backgroundColor,
      cursor: cs.cursor,
      colorScheme: cs.colorScheme,
      // 호버는 헤드리스에서 못 만든다 — 대신 코어 :hover 규칙이 읽는 **변수 값**을 확인한다(10차 1번).
      formFieldVar: cs.getPropertyValue('--background-modifier-form-field').trim(),
      formFieldHoverVar: cs.getPropertyValue('--background-modifier-form-field-hover').trim(),
    };
  }
  // 셀별 커서 — 편집 위치에서만 text 여야 한다(10차 2번).
  result.cursors = {
    editableCell: css('.bases-plus-cell.is-editable', ['cursor']),
    chips: css('.bases-plus-chips', ['cursor']),
  };

  // 알약은 줄지 않아야 한다 — 내용 폭보다 좁으면 잘린 것이다(마무리 요구).
  const pill = document.querySelector('.bases-plus-cell .multi-select-pill');
  if (pill) {
    const content = pill.querySelector('.multi-select-pill-content');
    const cs = getComputedStyle(content);
    result.pill = {
      pillWidth: Math.round(pill.getBoundingClientRect().width),
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      clipped: content.scrollWidth > content.clientWidth,
      textOverflow: cs.textOverflow,
      maxWidth: getComputedStyle(pill).maxWidth,
    };
  }

  // 칸 유형별 커서 실측 — 표식이 붙는지, 규칙이 잡는지, 토큰이 풀리는지 한 번에 본다.
  const lastRow = Array.from(document.querySelectorAll('.bases-plus-row')).filter((e) => e.offsetParent !== null).pop();
  if (lastRow) {
    const labels = ['이름', '텍스트', '날짜', '숫자', '목록', '빈날짜', '체크박스', '빈체크박스', '수식'];
    result.cursorByCell = Array.from(lastRow.querySelectorAll('.bases-plus-cell')).map((el, i) => {
      const cs = getComputedStyle(el);
      return {
        칸: labels[i] || String(i),
        isEditable: el.classList.contains('is-editable'),
        isTyping: el.classList.contains('is-typing'),
        cursorToken: cs.getPropertyValue('--cursor').trim(),
        cursor: cs.cursor,
      };
    });
  }

  /*
   * 축은 상자가 아니라 잉크다(A2) — 컨트롤마다 안쪽 여백이 달라 상자를 맞추면 글자·글리프가 어긋난다.
   * 그래서 요소의 **실제 왼쪽 끝**을 표 왼쪽 끝 기준으로 잰다.
   */
  const axisOf = (sel) => {
    const el = document.querySelector(sel);
    const table = document.querySelector('.bases-plus-table');
    if (!el || !table) return null;
    return Math.round(el.getBoundingClientRect().left - table.getBoundingClientRect().left);
  };
  const boxOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  };

  // 헤더 열과 본문 열이 계속 맞는가 — 손잡이를 첫 자식으로 넣으면 여기서 깨진다(C2 함정).
  result.colAligned =
    result.headerWidths.length === result.firstRowCellWidths.length &&
    result.headerWidths.every((w, i) => Math.abs(w - result.firstRowCellWidths[i]) <= 1);

  // 순서 모드 — 여백 열 폭과 표 왼쪽 잉크 축(손잡이 16 + 값 여백 8 = 24).
  const viewEl = document.querySelector('.bases-plus-view');
  if (viewEl) {
    result.orderGutter = getComputedStyle(viewEl).getPropertyValue('--bases-plus-order-gutter').trim();
    result.ordering = {
      isOrdering: viewEl.classList.contains('is-ordering'),
      handleBox: boxOf('.bases-plus-row .bases-plus-order-handle'),
      // 두 옵션이 독립이라 한쪽만 켰을 때 다른 쪽 손잡이가 함께 죽지 않는지 computed 로 본다.
      rowHandleDisplay: css('.bases-plus-row .bases-plus-order-handle', ['display']),
      groupHandleDisplay: css('.bases-plus-group-heading .bases-plus-order-handle', ['display']),
      classes: viewEl.className,
      rowLeft: axisOf('.bases-plus-row'),
      // 값 요소가 8px 안쪽 여백을 가지므로 잉크는 여기에 8 을 더한 자리다.
      valueLeft: axisOf('.bases-plus-row .bases-plus-value'),
      headerLabelLeft: axisOf('.bases-plus-th-label'),
      rowHeight: boxOf('.bases-plus-row') && boxOf('.bases-plus-row')[1],
    };
    result.dropIndicator = css('.bases-plus-drop-indicator', ['border-width', 'border-style', 'border-color', 'height']);
  }

  // 페이지 번호 입력칸 — 배경이 불투명하면 푸터의 inset 위 선을 덮는다(1차 4번).
  const pagerInput = document.querySelector('.bases-plus-pager-input');
  if (pagerInput) {
    const footer = document.querySelector('.bases-plus-footer');
    const fb = footer.getBoundingClientRect();
    const ib = pagerInput.getBoundingClientRect();
    const cs = getComputedStyle(pagerInput);
    result.pagerInput = {
      background: cs.backgroundColor,
      formFieldVar: cs.getPropertyValue('--background-modifier-form-field').trim(),
      formFieldHoverVar: cs.getPropertyValue('--background-modifier-form-field-hover').trim(),
      height: Math.round(ib.height),
      footerHeight: Math.round(fb.height),
      // 위 선은 푸터의 inset box-shadow 라, 입력칸이 그 1px 위에 걸치면 불투명할 때 덮인다.
      topGap: Math.round(ib.top - fb.top),
      bottomGap: Math.round(fb.bottom - ib.bottom),
      coversLine: Math.round(ib.top - fb.top) < 1,
    };
  }

  // 페이저 — 자리·치수·글리프 축(B2 · I1).
  const footerEl = document.querySelector('.bases-plus-footer');
  result.footer = footerEl
    ? css('.bases-plus-footer', ['position', 'bottom', 'z-index', 'height', 'background-color', 'box-shadow'])
    : null;
  const pagerButton = document.querySelector('.bases-plus-pager-button');
  if (pagerButton) {
    result.pager = {
      button: css('.bases-plus-pager-button', ['padding', 'border-radius', 'height', 'background-color', 'box-shadow', 'color']),
      disabledColor: (function () {
        const off = document.querySelector('.bases-plus-pager-button:disabled');
        return off ? getComputedStyle(off).color : null;
      })(),
      // 아이콘 버튼의 안쪽 여백이 6px 이라 상자는 2px 에서 시작하고 글리프가 8px 축에 선다.
      glyphLeft: axisOf('.bases-plus-pager-button svg') ?? axisOf('.bases-plus-pager-button'),
      buttonLeft: axisOf('.bases-plus-pager-button'),
      boxes: Array.from(document.querySelectorAll('.bases-plus-pager-button')).map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }),
      pageText: (document.querySelector('.bases-plus-pager-page') || {}).textContent,
      disabled: Array.from(document.querySelectorAll('.bases-plus-pager-button')).map((e) => e.disabled),
      pageColor: css('.bases-plus-pager-page', ['color', 'font-size']),
    };
  }

  // 그룹 푸터 — "Show all (N)" 문구의 왼쪽 끝이 셀 값과 같은 8px 축에 서야 한다(A2).
  const groupMore = document.querySelector('.bases-plus-group-more');
  if (groupMore) {
    result.groupFooter = {
      height: boxOf('.bases-plus-group-footer') && boxOf('.bases-plus-group-footer')[1],
      // 문구 버튼의 안쪽 여백이 4px 이라 상자는 4px 에서 시작한다.
      buttonLeft: axisOf('.bases-plus-group-more'),
      text: groupMore.textContent,
      style: css('.bases-plus-group-more', ['font-size', 'color', 'background-color', 'border-radius']),
    };
  }

  const heading = document.querySelector('.bases-plus-group-heading');
  if (heading) {
    result.groupToggle = css('.bases-plus-group-toggle svg', ['width', 'height', 'stroke-width', 'transform', 'color']);
    result.groupCount = css('.bases-plus-group-count', ['font-size', 'color']);
    result.headingState = Array.from(document.querySelectorAll('.bases-plus-group-heading'))
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({
        expanded: e.getAttribute('aria-expanded'),
        role: e.getAttribute('role'),
        collapsed: e.classList.contains('is-collapsed'),
        transform: getComputedStyle(e.querySelector('.bases-plus-group-toggle svg')).transform,
        count: e.querySelector('.bases-plus-group-count').textContent,
      }));
    // 접힌 그룹의 행은 **지우지 않고 감춘다** — 요소 풀 재사용 구조를 깨지 않기 위해서다(D2·성2).
    const rows = Array.from(document.querySelectorAll('.bases-plus-row'));
    result.collapsedRows = { total: rows.length, shown: rows.filter((e) => e.offsetParent !== null).length };
  }

  // 편집 중인 칸은 아래로 자란다 — 행 높이를 최소로 두고 내용만큼 커진다(E4).
  const editingCell = document.querySelector('.bases-plus-cell.is-editing');
  if (editingCell) {
    result.editingCell = Object.assign(
      css('.bases-plus-cell.is-editing', ['height', 'min-height', 'align-self', 'overflow', 'box-shadow']),
      { measuredHeight: Math.round(editingCell.getBoundingClientRect().height) }
    );
  }

  // 값 순서 대화상자 — 줄 높이·잉크 축이 표와 같아야 한다(F3).
  const orderItem = document.querySelector('.bases-plus-value-order-item');
  if (orderItem) {
    const modal = document.querySelector('.modal').getBoundingClientRect();
    const label = orderItem.querySelector('.bases-plus-value-order-label').getBoundingClientRect();
    result.valueOrder = {
      itemHeight: Math.round(orderItem.getBoundingClientRect().height),
      labelLeft: Math.round(label.left - orderItem.getBoundingClientRect().left),
      handleBox: boxOf('.bases-plus-value-order-item .bases-plus-order-handle'),
      titleLeft: Math.round(document.querySelector('.bases-plus-modal-title').getBoundingClientRect().left - modal.left),
      headerHeight: Math.round(document.querySelector('.bases-plus-modal-header').getBoundingClientRect().height),
      values: Array.from(document.querySelectorAll('.bases-plus-value-order-item')).map((e) => e.dataset.value),
      // 목록이 스스로 스크롤을 만들면 두 줄짜리 대화상자에도 스크롤바가 뜬다 — 눈으로만 잡히는 종류다.
      list: (function () {
        const el = document.querySelector('.bases-plus-value-order-list');
        const modal = document.querySelector('.modal');
        return {
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrolls: el.scrollHeight > el.clientHeight,
          modalHeight: Math.round(modal.getBoundingClientRect().height),
          modalWidth: Math.round(modal.getBoundingClientRect().width),
          contentHeight: Math.round(document.querySelector('.modal-content').getBoundingClientRect().height),
        };
      })(),
    };
  }

  if (heading) {
    result.heading = css('.bases-plus-group-heading', ['height', 'padding-block-start', 'background-color', 'box-shadow']);
    result.headingParts = {
      property: css('.bases-plus-group-property', ['font-size', 'font-weight', 'color']),
      value: css('.bases-plus-group-value', ['font-size', 'font-weight']),
    };
    result.headingHeights = Array.from(document.querySelectorAll('.bases-plus-group-heading'))
      .filter((e) => e.offsetParent !== null)
      .map((e) => Math.round(e.getBoundingClientRect().height));
  }

  // 겹침만 보면 부족하다 — 이번 규칙은 X 와 버튼의 **중심이 맞는 것**을 요구한다.
  const close = document.querySelector('.modal-header-button, .modal-close-button');
  if (close) {
    const modal = document.querySelector('.modal').getBoundingClientRect();
    const btn = close.getBoundingClientRect();
    const acts = Array.from(document.querySelectorAll('.bases-plus-modal-action')).map((e) => e.getBoundingClientRect());
    const last = acts[acts.length - 1];
    const headerEl = document.querySelector('.bases-plus-modal-header');
    const titleEl = document.querySelector('.bases-plus-modal-title');
    const round = (n) => Math.round(n * 100) / 100;

    result.modal = {
      headerHeight: headerEl ? Math.round(headerEl.getBoundingClientRect().height) : null,
      closeBox: { w: Math.round(btn.width), h: Math.round(btn.height), top: round(btn.top - modal.top), insetEnd: round(modal.right - btn.right) },
      closeCenterY: round(btn.top + btn.height / 2 - modal.top),
      lastActionCenterY: last ? round(last.top + last.height / 2 - modal.top) : null,
      centerYGap: last ? round(Math.abs(btn.top + btn.height / 2 - (last.top + last.height / 2))) : null,
      lastActionInsetEnd: last ? round(modal.right - last.right) : null,
      buttonToCloseGap: last ? round(btn.left - last.right) : null,
      actionHeight: last ? Math.round(last.height) : null,
      titleLeft: titleEl ? round(titleEl.getBoundingClientRect().left - modal.left) : null,
      actionsOverlapClose: acts.some((a) => a.right > btn.left && a.left < btn.right && a.bottom > btn.top && a.top < btn.bottom),
      coreTitleHidden: getComputedStyle(document.querySelector('.modal-header')).display === 'none',
      ourTitle: titleEl ? titleEl.textContent : null,
      headerChildren: headerEl ? Array.from(headerEl.children).map((e) => e.className) : null,
    };
  }
  // ── 타임라인 검수(명세 J1) — 두 판이 한 줄인지·머리가 한 y 에서 끝나는지·이름 자리를 computed 로 본다.
  const tlEl = document.querySelector('.bases-plus-timeline');
  if (tlEl) {
    const box = (sel, root) => {
      const el = (root || document).querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const rowEl2 = document.querySelector('.bases-plus-tl-row');
    const labelBox = box('.bases-plus-tl-label');
    const trackBox = box('.bases-plus-tl-track');
    const tiers = Array.from(document.querySelectorAll('.bases-plus-tl-tier'));
    const colsBox = box('.bases-plus-tl-corner-cols');
    const lastTier = tiers[tiers.length - 1];
    const barEl = document.querySelector('.bases-plus-tl-bar:not([style*="display:none"])');
    const barBox = barEl ? barEl.getBoundingClientRect() : null;
    const barLabelEl = barEl ? barEl.parentElement.querySelector('.bases-plus-tl-bar-label') : null;
    const barLabelBox = barLabelEl ? barLabelEl.getBoundingClientRect() : null;
    const handleEl = barEl ? barEl.querySelector('.bases-plus-tl-bar-handle.mod-end') : null;
    const trackStyle = trackBox ? getComputedStyle(document.querySelector('.bases-plus-tl-track')) : null;
    const pointEl = document.querySelector('.bases-plus-tl-point:not([style*="display:none"])');
    const dividerEl = document.querySelector('.bases-plus-tl-divider');
    const zAt = (el) => (el ? getComputedStyle(el).zIndex : null);

    /*
     * **이 페이지에서는 우리 JS 가 돌지 않는다** — 프리뷰는 뷰가 만든 DOM 을 정적으로 직렬화해 app.css 위에
     * 얹는 도구다. 그래서 스크롤 중의 이름 자리는 브라우저에서 스크롤해 재는 것이 아니라, **Node 쪽에서
     * 그 스크롤 상태로 갱신을 돌린 결과**를 직렬화해 오고 여기서는 그 좌표가 실제 레이아웃에서 맞는지 잰다
     * (timelineScrolled 모드). 스크롤 위치는 아래 data-scroll-left 가 페이지에 다시 적용한다.
     */
    const measureScroll = () => {
      if (!barEl || !barLabelEl) return;
      const paneEl = document.querySelector('.bases-plus-tl-label');
      const barLeft = barEl.getBoundingClientRect().left;
      const labelLeft = barLabelEl.getBoundingClientRect().left;
      const paneRight = paneEl.getBoundingClientRect().right;
      const hidden = Array.from(document.querySelectorAll('.bases-plus-tl-bar-label')).map(
        (el) => getComputedStyle(el).display === 'none'
      );

      result.timeline.scrolled = {
        scrollLeft: tlEl.scrollLeft,
        barLeft: Math.round(barLeft),
        labelLeft: Math.round(labelLeft),
        paneRight: Math.round(paneRight),
        // 확정 7-4 — 막대 왼쪽이 판 밑으로 들어갔으면 이름은 판 오른쪽 끝 + 8px 에 선다.
        insetFromPane: Math.round(labelLeft - paneRight),
        insetFromBar: Math.round(labelLeft - barLeft),
        labelsHidden: hidden,
      };
    };

    result.timeline = {
      rowHeight: rowEl2 ? Math.round(rowEl2.getBoundingClientRect().height) : null,
      labelSticky: css('.bases-plus-tl-label', ['position', 'inset-inline-start', 'overflow']),
      headSticky: css('.bases-plus-thead', ['position', 'top']),
      tierHeights: tiers.map((el) => Math.round(el.getBoundingClientRect().height)),
      // 열 이름 줄 바닥과 축 최하층 바닥이 같은 y 여야 두 판의 머리가 한 줄에서 끝난다(A3).
      headBottomsMatch:
        colsBox && lastTier
          ? Math.round(colsBox.bottom) === Math.round(lastTier.getBoundingClientRect().bottom)
          : null,
      headBottoms: colsBox && lastTier ? [Math.round(colsBox.bottom), Math.round(lastTier.getBoundingClientRect().bottom)] : null,
      barHeight: barBox ? Math.round(barBox.height) : null,
      barTop: barEl && trackBox ? Math.round(barBox.top - trackBox.top) : null,
      // 막대와 행의 세로 중앙이 같은지 — 차이 0 이어야 한다.
      barCenterDelta: barBox && rowEl2 ? Math.round(barBox.top + barBox.height / 2 - (rowEl2.getBoundingClientRect().top + rowEl2.getBoundingClientRect().height / 2)) : null,
      barLabelCount: document.querySelectorAll('.bases-plus-tl-row').length
        ? document.querySelector('.bases-plus-tl-track').querySelectorAll('.bases-plus-tl-bar-label').length
        : null,
      barLabelInset: barBox && barLabelBox ? Math.round(barLabelBox.left - barBox.left) : null,
      barLabelInk: barLabelEl ? getComputedStyle(barLabelEl).getPropertyValue('--bases-plus-tl-ink').trim() : null,
      barLabelClip: barLabelEl ? getComputedStyle(barLabelEl).webkitBackgroundClip || getComputedStyle(barLabelEl).backgroundClip : null,
      barLabelColor: barLabelEl ? getComputedStyle(barLabelEl).color : null,
      handleWidth: handleEl ? Math.round(handleEl.getBoundingClientRect().width) : null,
      handleCursor: handleEl ? getComputedStyle(handleEl).cursor : null,
      handleAboveLabel: handleEl && barLabelEl ? Number(zAt(handleEl)) > Number(zAt(barLabelEl) || 0) : null,
      unitWidth: Math.round(parseFloat(getComputedStyle(tlEl).getPropertyValue('--bases-plus-tl-unit-width'))),
      /*
       * 오늘은 트랙의 가상 요소다 — 격자와 분리돼 있어 한쪽이 죽어도 다른 쪽이 산다(4차 2번 처방).
       * 가상 요소는 선택자로 못 잡으므로 계산된 선언으로 확인한다.
       */
      todayLayer: (function () {
        const el = document.querySelector('.bases-plus-tl-track');
        if (!el) return null;
        const cs = getComputedStyle(el, '::before');
        return {
          content: cs.content,
          width: cs.width,
          left: cs.left,
          background: cs.backgroundColor,
          separateFromGrid: trackStyle ? trackStyle.backgroundImage.indexOf('linear-gradient') !== -1 : null,
        };
      })(),
      // **헤딩 줄에는 오늘도 격자도 칠해지지 않는다** — 트랙이 없으므로 구조적으로 불가능하다.
      headingHasTrack: !!document.querySelector('.bases-plus-group-heading .bases-plus-tl-track'),
      /*
       * 행과 트랙의 짝 — 보이는 행마다 트랙이 정확히 하나이고 폭이 모두 같아야 한다.
       * 어긋나면 몇 행만 격자·막대가 통째로 빠진 화면이 된다(3차 회귀 2번의 증상).
       */
      rowTrackPairing: (function () {
        const rows = Array.from(document.querySelectorAll('.bases-plus-row')).filter(
          (el) => getComputedStyle(el).display !== 'none'
        );
        const counts = rows.map((el) => el.querySelectorAll(':scope > .bases-plus-tl-track').length);
        const widths = rows
          .map((el) => el.querySelector(':scope > .bases-plus-tl-track'))
          .filter(Boolean)
          .map((el) => Math.round(el.getBoundingClientRect().width));
        return {
          rows: rows.length,
          everyRowHasOne: counts.every((n) => n === 1),
          widthsEqual: widths.length > 0 && widths.every((w) => w === widths[0]),
          width: widths[0] ?? null,
        };
      })(),
      dividerWidth: dividerEl ? Math.round(dividerEl.getBoundingClientRect().width) : null,
      dividerCursor: dividerEl ? getComputedStyle(dividerEl).cursor : null,
      pointSize: pointEl ? Math.round(pointEl.getBoundingClientRect().width) : null,
      overflowX: { scrollWidth: tlEl.scrollWidth, clientWidth: tlEl.clientWidth },
      tinted: barEl ? { isTinted: barEl.classList.contains('is-tinted'), background: getComputedStyle(barEl).backgroundColor, boxShadow: getComputedStyle(barEl).boxShadow, labelColor: barLabelEl ? getComputedStyle(barLabelEl).color : null } : null,
      colorButton: document.querySelectorAll('.bases-plus-tl-tool').length,
      groupHeadingSticky: css('.bases-plus-tl-group-inner', ['position', 'inset-inline-start']),
      footerHeight: box('.bases-plus-footer') ? Math.round(box('.bases-plus-footer').height) : null,
      headingHeight: box('.bases-plus-group-heading') ? Math.round(box('.bases-plus-group-heading').height) : null,
      countSize: css('.bases-plus-group-count', ['font-size']),
      // 격자는 요소가 아니라 배경이다 — 선언이 살아 있는지 computed 로만 확인된다.
      trackGrid: css('.bases-plus-tl-track', ['background-image']),
      // 그룹 수동 순서 — 헤딩 손잡이가 띠 안에서 어디에 서고, 띠가 내용 폭을 다 덮는지(2차 요청).
      groupOrder: (function () {
        const headings = Array.from(document.querySelectorAll('.bases-plus-group-heading'));
        const handle = document.querySelector('.bases-plus-group-heading > .bases-plus-order-handle');
        const rows = document.querySelector('.bases-plus-rows');
        if (!headings.length || !rows) return null;
        const first = headings[0].getBoundingClientRect();
        const dragged = document.querySelector('.bases-plus-group-heading.is-being-dragged');
        const hs = handle ? getComputedStyle(handle) : null;
        return {
          headingWidth: Math.round(first.width),
          rowsWidth: Math.round(rows.getBoundingClientRect().width),
          headingCoversRow: Math.round(first.width) >= Math.round(rows.getBoundingClientRect().width) - 1,
          handle: handle
            ? {
                left: Math.round(handle.getBoundingClientRect().left),
                top: Math.round(handle.getBoundingClientRect().top - first.top),
                height: Math.round(handle.getBoundingClientRect().height),
                opacity: hs.opacity,
                background: hs.backgroundColor,
              }
            : null,
          draggedWidth: dragged ? Math.round(dragged.getBoundingClientRect().width) : null,
          draggedBackground: dragged ? getComputedStyle(dragged).backgroundColor : null,
        };
      })(),
      // 머리(코너)와 본문 첫 열이 같은 x 에서 시작하는지 — 여백 열·화살표 자리를 더하며 어긋나기 쉬운 자리다.
      columnsAligned: (function () {
        const head = document.querySelector('.bases-plus-tl-corner-cols .bases-plus-th');
        const body = document.querySelector('.bases-plus-tl-label .bases-plus-cell');
        if (!head || !body) return null;
        const h = Math.round(head.getBoundingClientRect().left);
        const b = Math.round(body.getBoundingClientRect().left);
        return { head: h, body: b, aligned: h === b };
      })(),
      /*
       * 트랙 배경이 **모든 행에서 실제로 칠해지는지**. 요소가 있고 폭이 맞아도 배경이 죽어 있으면
       * 격자가 통째로 빈다 — T10 의 rowTrackPairing 은 존재·폭만 봐서 그 상태를 놓쳤다(4차 2번).
       */
      trackBackgrounds: (function () {
        const rows = Array.from(document.querySelectorAll('.bases-plus-row')).filter(
          (el) => getComputedStyle(el).display !== 'none'
        );
        const seen = rows.map((row) => {
          const track = row.querySelector(':scope > .bases-plus-tl-track');
          if (!track) return { ok: false, why: 'no-track' };
          const cs = getComputedStyle(track);
          return {
            ok: cs.backgroundImage !== 'none' && cs.backgroundImage.indexOf('repeating-linear-gradient') !== -1,
            width: Math.round(track.getBoundingClientRect().width),
          };
        });
        return {
          rows: seen.length,
          allPainted: seen.every((r) => r.ok),
          brokenAt: seen.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0),
          widths: Array.from(new Set(seen.map((r) => r.width))),
        };
      })(),
      // 연관 행 — 부속물로 보이는지(들여쓰기 16px · 낮은 채도)를 부모와 나란히 잰다(F1).
      /*
       * 헤딩 띠와 그 위의 정박 상자·손잡이가 **같은 색으로 보이는지**(5차 2·3번).
       * 자기 배경을 갖지 않아야 알파가 겹쳐 진해지지도, 옛 색으로 남아 밝아지지도 않는다.
       */
      headingPaint: (function () {
        const heading = document.querySelector('.bases-plus-group-heading');
        if (!heading) return null;
        const tail = heading.querySelector('.bases-plus-tl-group-tail');
        const handle = heading.querySelector('.bases-plus-order-handle');
        const own = (el) => (el ? getComputedStyle(el).backgroundColor : null);
        return {
          band: own(heading),
          tail: own(tail),
          handle: own(handle),
          // 둘 다 투명이어야 띠가 그대로 비쳐 같은 색이 된다.
          tailTransparent: tail ? own(tail) === 'rgba(0, 0, 0, 0)' : null,
          handleTransparent: handle ? own(handle) === 'rgba(0, 0, 0, 0)' : null,
        };
      })(),
      // 헤딩 글자가 가로 스크롤 뒤에도 화면 왼쪽에 남는지 — 선언이 아니라 **좌표**로 본다(1차 27번).
      groupHeadingInk: (function () {
        const el = document.querySelector('.bases-plus-tl-group-inner');
        const view = document.querySelector('.bases-plus-timeline');
        if (!el || !view) return null;
        const box = el.getBoundingClientRect();
        const property = el.querySelector('.bases-plus-group-property');
        const value = el.querySelector('.bases-plus-group-value');
        return {
          left: Math.round(box.left),
          viewLeft: Math.round(view.getBoundingClientRect().left),
          scrollLeft: view.scrollLeft,
          headingOverflow: getComputedStyle(el.closest('.bases-plus-group-heading')).overflow,
          // 속성명과 값이 겹치지 않는지 — 조각마다 sticky 를 걸면 같은 x 로 몰린다.
          // 개수·`+` 묶음이 오른쪽에 남는지 — 스크롤에도 화면 안에 있어야 한다(2차 8번).
          tail: (function () {
            const t = document.querySelector('.bases-plus-tl-group-tail');
            const v = document.querySelector('.bases-plus-timeline');
            if (!t || !v) return null;
            const tb = t.getBoundingClientRect();
            const vb = v.getBoundingClientRect();
            return {
              right: Math.round(tb.right),
              viewRight: Math.round(vb.right),
              inView: tb.right <= vb.right + 1 && tb.left >= vb.left,
              hasAdd: !!t.querySelector('.bases-plus-group-add'),
            };
          })(),
          piecesOverlap:
            property && value
              ? Math.round(property.getBoundingClientRect().right) > Math.round(value.getBoundingClientRect().left)
              : null,
        };
      })(),
      /*
       * 여백 열이 **비어 있지 않은지**. 그룹 순서만 켜면 행에는 손잡이가 안 그려지는데, 그래도 판은
       * 그만큼 안쪽에 붙으므로 그 자리가 비면 트랙이 판 왼쪽 바깥으로 비친다(5차 요청).
       */
      gutterFill: (function () {
        const row = document.querySelector('.bases-plus-row');
        const root = document.querySelector('.bases-plus-view');
        if (!row) return null;
        const cs = getComputedStyle(row, '::before');
        return {
          rootClasses: root ? root.className : null,
          content: cs.content,
          width: cs.width,
          background: cs.backgroundColor,
        };
      })(),
      // 여백 열이 가로 스크롤에도 남는지 — 손잡이와 판이 나란히 고정돼야 한다(1차 31번).
      gutter: (function () {
        const handle = document.querySelector('.bases-plus-row > .bases-plus-order-handle');
        const pane = document.querySelector('.bases-plus-tl-label');
        if (!handle || !pane) return null;
        const hs = getComputedStyle(handle);
        return {
          position: hs.position,
          width: Math.round(handle.getBoundingClientRect().width),
          left: Math.round(handle.getBoundingClientRect().left),
          paneLeft: Math.round(pane.getBoundingClientRect().left),
        };
      })(),
      // 위 층 글자가 가로 스크롤에도 왼쪽에 남는지(E1 과 같은 처리).
      topTierLabel: (function () {
        const el = document.querySelector('.bases-plus-tl-tier .bases-plus-tl-seg-label');
        if (!el) return null;
        const s2 = getComputedStyle(el);
        const box2 = el.getBoundingClientRect();
        return { text: el.textContent, position: s2.position, left: Math.round(box2.left), width: Math.round(box2.width) };
      })(),
    };
    measureScroll();
  }
  // 색 대화상자 스와치 — 팔레트 변수가 모달 안에서도 풀리는지(1차 21번).
  const swatches = document.querySelectorAll('.bases-plus-bar-color-swatch');
  if (swatches.length) {
    result.swatches = Array.from(swatches).slice(0, 8).map((el) => getComputedStyle(el).backgroundColor);
    result.swatchPainted = result.swatches.every((c) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent');
  }
  // ── 달력 검수(명세 H + 마스터 1차 반영) — 그리드는 **주 단위**라 측정도 주에서 출발한다.
  const calEl = document.querySelector('.bases-plus-calendar');
  if (calEl) {
    const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter((e) => e.offsetParent !== null);
    const boxOfEl = (el) => (el ? [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)] : null);
    const pick = (list) => (list.length ? list[0] : null);
    const weeks = shown('.bases-plus-cal-week');
    const days = shown('.bases-plus-cal-day');
    const heads = shown('.bases-plus-cal-dayhead');
    const todayEl = pick(days.filter((e) => e.classList.contains('is-today')));
    const outsideHead = pick(heads.filter((e) => e.classList.contains('is-outside')));
    const outsideEl = pick(days.filter((e) => e.classList.contains('is-outside')));
    /*
     * **이번 달 안의 주말**만 고른다. 이번 달 밖 칸은 주말이기도 해서(7월 26일은 일요일) 그걸 재면
     * 달 밖 칸이 칠한 배경을 주말 규칙의 것으로 착각한다 — 대조군 없는 측정의 함정이다.
     */
    const weekendEl = pick(days.filter((e) => e.classList.contains('is-weekend') && !e.classList.contains('is-today') && !e.classList.contains('is-outside')));
    const plainEl = pick(days.filter((e) => !e.classList.contains('is-today') && !e.classList.contains('is-outside') && !e.classList.contains('is-weekend')));
    const moreEl = pick(shown('.bases-plus-cal-more'));
    const itemEl = pick(shown('.bases-plus-cal-item'));
    const slotEl = itemEl ? itemEl.closest('.bases-plus-cal-slot') : null;
    const clippedStart = pick(shown('.bases-plus-cal-item.is-clipped-start'));
    const clippedEnd = pick(shown('.bases-plus-cal-item.is-clipped-end'));
    const roundEl = pick(shown('.bases-plus-cal-item').filter((e) => !e.classList.contains('is-clipped-start') && !e.classList.contains('is-clipped-end')));
    const taskEl = pick(shown('.bases-plus-cal-task'));
    const doneEl = pick(shown('.bases-plus-cal-task.is-done'));
    const cancelledEl = pick(shown('.bases-plus-cal-task.is-cancelled'));
    // 오늘 틴트는 **타임라인과 같은 산식**이어야 한다 — 같은 선언을 임시 요소에 얹어 계산값을 나란히 놓는다.
    const gauge = document.createElement('div');
    gauge.style.backgroundColor = 'color-mix(in oklch, var(--color-accent) 15%, transparent)';
    calEl.appendChild(gauge);
    const tintReference = getComputedStyle(gauge).backgroundColor;
    gauge.remove();

    /*
     * **같은 줄이면 같은 높이인가**(마스터 1차 16·22번). 줄이 그리드 행이라 구조적으로 보장되지만,
     * 칩이 그 높이를 채우지 않으면 화면에서는 어긋나 보인다 — 그래서 칩 상자를 줄별로 모아 잰다.
     */
    const laneHeights = weeks.map((weekEl) => {
      const byLane = {};
      Array.from(weekEl.querySelectorAll('.bases-plus-cal-slot')).forEach((el) => {
        if (el.offsetParent === null) return;
        const lane = String(getComputedStyle(el).gridRowStart);
        const height = Math.round(el.getBoundingClientRect().height);
        (byLane[lane] = byLane[lane] || []).push(height);
      });
      return byLane;
    });
    const laneEven = laneHeights.every((byLane) =>
      Object.keys(byLane).every((lane) => byLane[lane].every((h) => Math.abs(h - byLane[lane][0]) <= 1))
    );

    result.calendar = {
      weekCount: weeks.length,
      dayCount: days.length,
      columns: weeks.length ? Array.from(weeks[0].querySelectorAll('.bases-plus-cal-day')).map((e) => Math.round(e.getBoundingClientRect().width)) : [],
      columnsEqual: weeks.length
        ? Array.from(weeks[0].querySelectorAll('.bases-plus-cal-day')).every((e, i, all) => Math.abs(e.getBoundingClientRect().width - all[0].getBoundingClientRect().width) <= 1)
        : null,
      gridGap: getComputedStyle(document.querySelector('.bases-plus-cal-grid')).gap,
      weekGap: weeks.length ? getComputedStyle(weeks[0]).columnGap : null,
      // 격자선은 gap + 배경으로 만든다 — 칸에 테두리가 있으면 인접한 선이 2px 로 겹친다(A3).
      dayBorderWidth: plainEl ? getComputedStyle(plainEl).borderWidth : null,
      weekMinHeight: weeks.length ? getComputedStyle(weeks[0]).minHeight : null,
      rowHeights: weeks.map((e) => Math.round(e.getBoundingClientRect().height)),
      // 배경 칸이 주 바닥까지 닿는가 — 안 닿으면 격자색이 띠로 비친다.
      dayCoversWeek: weeks.every((weekEl) => {
        const day = weekEl.querySelector('.bases-plus-cal-day');
        return day && Math.abs(day.getBoundingClientRect().height - weekEl.getBoundingClientRect().height) <= 1;
      }),
      laneEven: laneEven,
      laneHeights: laneHeights,
      today: todayEl ? { background: getComputedStyle(todayEl).backgroundColor } : null,
      todayNum: pick(heads.filter((e) => e.classList.contains('is-today')))
        ? getComputedStyle(pick(heads.filter((e) => e.classList.contains('is-today'))).querySelector('.bases-plus-cal-daynum')).fontWeight
        : null,
      tintReference: tintReference,
      tintMatches: todayEl ? getComputedStyle(todayEl).backgroundColor === tintReference : null,
      outside: outsideEl ? { background: getComputedStyle(outsideEl).backgroundColor } : null,
      outsideNum: outsideHead ? getComputedStyle(outsideHead.querySelector('.bases-plus-cal-daynum')).color : null,
      weekend: weekendEl ? getComputedStyle(weekendEl).backgroundColor : null,
      // 주말이면서 오늘이면 **오늘이 이긴다** — 두 배경을 섞지 않는다(B1).
      weekendToday: todayEl && todayEl.classList.contains('is-weekend') ? getComputedStyle(todayEl).backgroundColor : null,
      altToken: plainEl ? getComputedStyle(plainEl).getPropertyValue('--background-primary-alt').trim() : null,
      faintToken: plainEl ? getComputedStyle(plainEl).getPropertyValue('--text-faint').trim() : null,
      item: itemEl
        ? Object.assign(css('.bases-plus-cal-item', ['min-height', 'background-color', 'border-radius', 'color', 'font-size', 'overflow', 'cursor']), {
            box: boxOfEl(itemEl),
            // 칩이 줄 높이를 채우는가 — 안 채우면 옆 칸의 큰 칩과 나란해 보이지 않는다.
            fillsSlot: slotEl ? Math.abs(itemEl.getBoundingClientRect().height - slotEl.getBoundingClientRect().height) <= 1 : null,
            // 배경이 **약간 투명**해야 한다(마스터 1차 요청) — 알파가 1 이면 요청이 안 먹은 것이다.
            translucent: getComputedStyle(itemEl).backgroundColor.indexOf('/') !== -1 || getComputedStyle(itemEl).backgroundColor.indexOf('rgba') === 0,
          })
        : null,
      // 여러 날 막대가 **칸을 가로지르는 한 요소**인가(1차 16번). 폭이 한 열보다 넓으면 걸친 것이다.
      spanning: (function () {
        const columnWidth = weeks.length ? weeks[0].querySelector('.bases-plus-cal-day').getBoundingClientRect().width : 0;
        const wide = shown('.bases-plus-cal-slot').filter((e) => e.getBoundingClientRect().width > columnWidth * 1.5);
        return { columnWidth: Math.round(columnWidth), count: wide.length, widest: wide.length ? Math.round(Math.max.apply(null, wide.map((e) => e.getBoundingClientRect().width))) : 0 };
      })(),
      clipped: {
        start: clippedStart ? getComputedStyle(clippedStart).borderRadius : null,
        end: clippedEnd ? getComputedStyle(clippedEnd).borderRadius : null,
        round: roundEl ? getComputedStyle(roundEl).borderRadius : null,
      },
      task: taskEl
        ? {
            background: getComputedStyle(taskEl).backgroundColor,
            minHeight: getComputedStyle(taskEl).minHeight,
            done: doneEl ? { color: getComputedStyle(doneEl).color, decoration: getComputedStyle(doneEl).textDecorationLine } : null,
            cancelled: cancelledEl ? { color: getComputedStyle(cancelledEl).color, decoration: getComputedStyle(cancelledEl).textDecorationLine } : null,
            glyphs: shown('.bases-plus-cal-check').map((e) => e.textContent),
          }
        : null,
      more: moreEl
        ? {
            text: moreEl.textContent,
            box: boxOfEl(moreEl),
            justifyContent: getComputedStyle(moreEl).justifyContent,
            textLeft: (function () {
              const r = document.createRange();
              r.selectNodeContents(moreEl);
              return Math.round(r.getBoundingClientRect().left - moreEl.closest('.bases-plus-cal-week').getBoundingClientRect().left);
            })(),
          }
        : null,
      head: Object.assign(css('.bases-plus-cal-head', ['position', 'top', 'height', 'background-color']), { box: boxOfEl(document.querySelector('.bases-plus-cal-head')) }),
      // 기간 이름은 **누를 수 있는 것**이다(년·월 선택) — 버튼인데 글자가 가운데로 가지 않았는지 본다.
      period: (function () {
        const el = document.querySelector('.bases-plus-cal-period');
        if (!el) return null;
        const r = document.createRange();
        r.selectNodeContents(el);
        return { text: el.textContent, justifyContent: getComputedStyle(el).justifyContent, textLeft: Math.round(r.getBoundingClientRect().left - calEl.getBoundingClientRect().left) };
      })(),
      weekdays: Object.assign(css('.bases-plus-cal-weekdays', ['position', 'top']), {
        names: shown('.bases-plus-cal-weekday').map((e) => e.textContent),
        height: Math.round(document.querySelector('.bases-plus-cal-weekday').getBoundingClientRect().height),
      }),
      nav: shown('.bases-plus-cal-nav .bases-plus-pager-button').map(boxOfEl),
      modes: shown('.bases-plus-cal-mode').map((e) => ({ text: e.textContent, active: e.classList.contains('is-active') })),
      // 속성은 칩 **안에** 이름:값 한 줄씩 목록으로 선다(1차 22번 수정).
      props: (function () {
        const el = pick(shown('.bases-plus-cal-item-props'));
        if (!el) return null;
        const row = el.querySelector('.bases-plus-cal-item-prop');
        const valueInput = el.querySelector('.bases-plus-cal-prop-value input');
        return {
          insideChip: !!el.closest('.bases-plus-cal-item'),
          rows: el.querySelectorAll('.bases-plus-cal-item-prop').length,
          text: row ? row.textContent : null,
          nameAfter: row ? getComputedStyle(row.querySelector('.bases-plus-cal-prop-name'), '::after').content : null,
          // 코어가 날짜 값을 입력칸으로 그린다 — 강조색 위라 그 장식을 지웠는지 본다.
          valueInput: valueInput
            ? { background: getComputedStyle(valueInput).backgroundColor, border: getComputedStyle(valueInput).borderWidth, color: getComputedStyle(valueInput).color }
            : null,
        };
      })(),
      // 칩 안 조작 골격(1차 요청 ⑩).
      controls: {
        checkbox: pick(shown('.bases-plus-cal-check-box')) ? pick(shown('.bases-plus-cal-check-box')).textContent : null,
        pill: pick(shown('.bases-plus-cal-item-pill'))
          ? { text: pick(shown('.bases-plus-cal-item-pill')).textContent, background: getComputedStyle(pick(shown('.bases-plus-cal-item-pill'))).backgroundColor }
          : null,
      },
      // 2차 8번 — 기본 칩은 배경이 거의 없어야 한다. 색을 켜면 타임라인 산식(20% 채움 + 3px 띠)이다.
      chipPaint: (function () {
        const el = itemEl;
        if (!el) return null;
        const band = document.querySelector('.bases-plus-cal-item.is-band');
        return {
          background: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
          tinted: el.classList.contains('is-tinted'),
          bandShadow: band ? getComputedStyle(band).boxShadow : null,
          bandCount: document.querySelectorAll('.bases-plus-cal-item.is-band').length,
          tintedCount: document.querySelectorAll('.bases-plus-cal-item.is-tinted').length,
        };
      })(),
      // 2차 10번 — 속성 줄은 두 열 그리드라 값이 같은 x 에서 시작하고 이름 크기가 값과 같아야 한다.
      propAlign: (function () {
        const listEl = Array.from(document.querySelectorAll('.bases-plus-cal-item-props')).filter((e) => e.offsetParent !== null)[0];
        if (!listEl) return null;
        const names = Array.from(listEl.querySelectorAll('.bases-plus-cal-prop-name'));
        const values = Array.from(listEl.querySelectorAll('.bases-plus-cal-prop-value'));
        const left = (el) => Math.round(el.getBoundingClientRect().left);
        return {
          columns: getComputedStyle(listEl).gridTemplateColumns,
          // 글자가 실제로 어디서 시작하는가 — 상자 왼쪽이 아니라 이름의 왼쪽을 잰다(패딩이 안쪽에 있다).
          indent: names.length
            ? Math.round(names[0].getBoundingClientRect().left - listEl.closest('.bases-plus-cal-item').getBoundingClientRect().left)
            : null,
          titleLeft: (function () {
            const t = listEl.closest('.bases-plus-cal-item').querySelector('.bases-plus-cal-item-text');
            return t ? Math.round(t.getBoundingClientRect().left - listEl.closest('.bases-plus-cal-item').getBoundingClientRect().left) : null;
          })(),
          nameFont: names.length ? getComputedStyle(names[0]).fontSize : null,
          valueFont: values.length ? getComputedStyle(values[0]).fontSize : null,
          fontMatches: names.length && values.length ? getComputedStyle(names[0]).fontSize === getComputedStyle(values[0]).fontSize : null,
          valueLefts: values.map(left),
          // 값의 시작 x 가 하나로 모여야 정렬된 것이다(캡처 지적의 판정선).
          valuesAligned: values.length ? values.every((el) => Math.abs(left(el) - left(values[0])) <= 1) : null,
        };
      })(),
      // 날짜 값은 코어가 **분절 입력칸**으로 그린다 — 칸이 좁으면 줄지 않고 잘린다(캡처: "08/22/:").
      dateValue: (function () {
        const all = Array.from(document.querySelectorAll('.bases-plus-cal-prop-value input[type="date"]'));
        if (!all.length) return null;
        const measured = all.map((el) => {
          const box = el.closest('.bases-plus-cal-prop-value');
          return {
            inputWidth: Math.round(el.getBoundingClientRect().width),
            boxWidth: Math.round(box.getBoundingClientRect().width),
            clipped: el.scrollWidth > Math.ceil(el.getBoundingClientRect().width) + 1,
          };
        });
        return { count: measured.length, clipped: measured.filter((m) => m.clipped).length, narrowest: measured.sort((a, b) => a.boxWidth - b.boxWidth)[0] };
      })(),
      // 4번 지적 — 이름과 값의 세로 정렬·행 간격·체크박스 값의 실물을 줄마다 잰다.
      propRows: (function () {
        // **보이는** 목록에서 잰다 — 첫 요소는 태스크 줄처럼 속성이 없는 슬롯의 빈 목록일 수 있다.
        const listEl = Array.from(document.querySelectorAll('.bases-plus-cal-item-props')).filter((e) => e.offsetParent !== null)[0];
        if (!listEl) return null;
        const rows = Array.from(listEl.querySelectorAll('.bases-plus-cal-item-prop'));
        return rows.map((row) => {
          const name = row.querySelector('.bases-plus-cal-prop-name');
          const value = row.querySelector('.bases-plus-cal-prop-value');
          const nb = name.getBoundingClientRect();
          const vb = value.getBoundingClientRect();
          const child = value.firstElementChild;
          return {
            name: name.textContent,
            nameTop: Math.round(nb.top),
            valueTop: Math.round(vb.top),
            // 두 글자 상자의 위 끝 차이 — 0 이 아니면 눈에 어긋나 보인다(캡처 지적).
            topGap: Math.round(vb.top - nb.top),
            nameHeight: Math.round(nb.height),
            valueHeight: Math.round(vb.height),
            valueFont: getComputedStyle(value).fontSize,
            nameLineHeight: getComputedStyle(name).lineHeight,
            valuePadding: getComputedStyle(value).padding,
            valueMinHeight: getComputedStyle(value).minHeight,
            valueDisplay: getComputedStyle(value).display,
            valueAlignSelf: getComputedStyle(value).alignSelf,
            valueLineHeight: getComputedStyle(value).lineHeight,
            rowGap: getComputedStyle(listEl).rowGap,
            alignItems: getComputedStyle(listEl).alignItems,
            tightToken: getComputedStyle(listEl).getPropertyValue('--line-height-tight').trim(),
            childTag: child ? child.tagName.toLowerCase() : null,
            childClass: child ? child.className : null,
            childHeight: child ? Math.round(child.getBoundingClientRect().height) : null,
            childWidth: child ? Math.round(child.getBoundingClientRect().width) : null,
          };
        });
      })(),
      handles: (function () {
        const el = document.querySelector('.bases-plus-cal-handle.mod-start');
        if (!el) return null;
        const item = el.closest('.bases-plus-cal-item');
        const itemBox = item.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          width: getComputedStyle(el).width,
          cursor: getComputedStyle(el).cursor,
          starts: document.querySelectorAll('.bases-plus-cal-handle.mod-start:not([style*="display: none"])').length,
          ends: document.querySelectorAll('.bases-plus-cal-handle.mod-end:not([style*="display: none"])').length,
          // 손잡이가 칩 안에 온전히 들어와야 이웃의 손잡이와 겹치지 않는다(4차 4번의 가설 중 하나).
          insideItem: box.left >= itemBox.left - 0.5 && box.right <= itemBox.right + 0.5,
          zIndex: getComputedStyle(el).zIndex,
          // 이웃 칩의 손잡이와 얼마나 떨어져 있나 — 0 이하면 붙어 있어 잘못 잡힌다.
          neighbourGap: (function () {
            const ends = Array.from(document.querySelectorAll('.bases-plus-cal-handle.mod-end')).filter((e) => e.offsetParent !== null);
            const starts = Array.from(document.querySelectorAll('.bases-plus-cal-handle.mod-start')).filter((e) => e.offsetParent !== null);
            let closest = null;
            for (const endEl of ends) {
              for (const startEl of starts) {
                if (endEl.closest('.bases-plus-cal-slot') === startEl.closest('.bases-plus-cal-slot')) continue;
                const a = endEl.getBoundingClientRect();
                const b = startEl.getBoundingClientRect();
                if (Math.abs(a.top - b.top) > 2) continue;
                const gap = Math.round(b.left - a.right);
                if (gap >= 0 && (closest === null || gap < closest)) closest = gap;
              }
            }
            return closest;
          })(),
        };
      })(),
      ellipsis: (function () {
        const textEl = document.querySelector('.bases-plus-cal-item-text');
        if (!textEl) return null;
        return {
          textOverflow: getComputedStyle(textEl).textOverflow,
          clipped: Array.from(document.querySelectorAll('.bases-plus-cal-item-text')).some((e) => e.scrollWidth > e.clientWidth + 1),
          chipTextOverflow: getComputedStyle(textEl.closest('.bases-plus-cal-item')).textOverflow,
        };
      })(),
      // 뷰 안에 세로 스크롤을 만들지 않는다 — 임베드는 overflow:hidden 이라 통째로 잘린다(A4).
      viewHeight: Math.round(document.querySelector('.bases-plus-view').getBoundingClientRect().height),
      scrolls: calEl.scrollHeight > calEl.clientHeight,
      notice: (function () {
        const el = document.querySelector('.bases-plus-notice');
        return el ? { shown: getComputedStyle(el).display !== 'none', text: el.textContent } : null;
      })(),
      expandedWeeks: shown('.bases-plus-cal-week.is-expanded').length,
      wrap: calEl.classList.contains('is-wrap')
        ? { whiteSpace: getComputedStyle(document.querySelector('.bases-plus-cal-item-text')).whiteSpace }
        : null,
    };

    const embedEl = document.querySelector('.bases-embed');
    if (embedEl) {
      result.calendarEmbed = {
        embedHeight: Math.round(embedEl.getBoundingClientRect().height),
        contentHeight: Math.round(document.querySelector('.bases-plus-view').getBoundingClientRect().height),
        overflow: getComputedStyle(embedEl).overflow,
        clipped: document.querySelector('.bases-plus-view').getBoundingClientRect().height > embedEl.getBoundingClientRect().height + 1,
      };
    }
  }

  // ── 그래프 (4단계) — H 검수 기준을 computed 값으로 되읽는다 ────────────────────────
  const graphEl = document.querySelector('.bases-plus-graph');
  if (graphEl) {
    /*
     * 토큰이 실제로 무슨 색이 되는지는 **같은 식을 쓰는 요소를 세워** 확인한다. 커스텀 속성을 그대로 읽으면
     * var(--color-base-35) 처럼 치환 전 문자열이 나와 stroke 와 비교할 수 없다.
     */
    const resolve = (expr) => {
      const el = document.createElement('div');
      el.style.color = expr;
      document.body.appendChild(el);
      const value = getComputedStyle(el).color;
      el.remove();
      return value;
    };
    const nums = (sel, attrs) =>
      Array.from(document.querySelectorAll(sel)).reduce((acc, el) => {
        attrs.forEach((name) => acc.push(parseFloat(el.getAttribute(name))));
        return acc;
      }, []);
    const dotEl = document.querySelector('.bases-plus-graph-dot');
    const plotBox = document.querySelector('.bases-plus-graph-plot').getBoundingClientRect();
    const dashedEl = document.querySelector('.bases-plus-graph-line.is-dashed');
    const swatchEl = document.querySelector('.bases-plus-graph-swatch');
    // 세로 좌표가 음수면 그 요소는 플롯 위(범례 자리)에 그려진다 — 목업 첫 렌더가 그랬다(B2).
    const ys = nums('.bases-plus-graph-grid line, .bases-plus-graph-axis line', ['y1', 'y2'])
      .concat(nums('.bases-plus-graph-grid text, .bases-plus-graph-axis text', ['y']));

    result.graph = {
      plot: css('.bases-plus-graph-plot', ['min-height', 'position']),
      plotHeight: Math.round(plotBox.height),
      plotWidth: Math.round(plotBox.width),
      canvas: css('.bases-plus-graph-canvas', ['position', 'overflow-x']),
      grid: css('.bases-plus-graph-grid line', ['stroke', 'stroke-width']),
      graphLineToken: resolve('var(--graph-line)'),
      axisText: css('.bases-plus-graph-axis text', ['fill', 'font-size']),
      textMutedToken: resolve('var(--text-muted)'),
      line: css('.bases-plus-graph-line', ['stroke', 'stroke-width', 'stroke-linecap', 'fill']),
      series1Token: resolve('var(--color-blue)'),
      series2Token: resolve('var(--color-orange)'),
      lineColors: Array.from(document.querySelectorAll('.bases-plus-graph-line')).map((el) => getComputedStyle(el).stroke),
      dashed: dashedEl
        ? { stroke: getComputedStyle(dashedEl).stroke, dasharray: getComputedStyle(dashedEl).strokeDasharray }
        : null,
      dot: css('.bases-plus-graph-dot', ['width', 'height', 'border-width', 'border-color', 'background-color', 'cursor', 'border-radius']),
      backgroundPrimaryToken: resolve('var(--background-primary)'),
      // --cursor-link 가 죽어 있으면 점이 "눌러 열 수 있는 것"으로 안 읽힌다(C3).
      cursorLinkToken: (function () {
        const el = document.createElement('div');
        el.style.cursor = 'var(--cursor-link)';
        document.body.appendChild(el);
        const value = getComputedStyle(el).cursor;
        el.remove();
        return value;
      })(),
      dotHover: css('.sim .bases-plus-graph-dot:nth-child(2)', ['width', 'height']),
      legendSwatch: swatchEl
        ? { background: getComputedStyle(swatchEl).backgroundColor, width: getComputedStyle(swatchEl).width, borderRadius: getComputedStyle(swatchEl).borderRadius }
        : null,
      legendHeight: Math.round(document.querySelector('.bases-plus-graph-legend').getBoundingClientRect().height),
      /*
       * 범례는 이제 **누르는 자리**다 — 코어 button 선언(높이 30px·배경·테두리)을 되돌렸는지,
       * 감춘 줄이 자리를 지키며 흐려지는지는 computed 로만 확인된다.
       */
      legendItem: css('.bases-plus-graph-legend-item', ['height', 'background-color', 'border-width', 'cursor', 'opacity', 'font-size']),
      legendOff: (function () {
        const el = document.querySelector('.bases-plus-graph-legend-item.is-off');
        if (!el) return null;
        const style = getComputedStyle(el);
        return { opacity: style.opacity, display: style.display, pressed: el.getAttribute('aria-pressed'), label: el.getAttribute('aria-label') };
      })(),
      /*
       * 툴팁은 **코어가 띄운다.** 코어는 [aria-label] 위임으로 대상을 잡고 그 대상이 HTMLElement 일 때만
       * 그린다(1.13.6 app.js) — 점이 SVG 면 그 자리에서 죽는다. 그래서 두 조건을 함께 잰다.
       */
      tooltip: dotEl
        ? {
            hasAriaLabel: dotEl.hasAttribute('aria-label'),
            text: dotEl.getAttribute('aria-label'),
            isHtmlElement: dotEl instanceof HTMLElement,
            isSvgElement: dotEl instanceof SVGElement,
            // 코어는 이 둘을 hover 때 다시 읽어 지연과 자리를 정한다(app.js Yg → Ug → Kg).
            delay: dotEl.getAttribute('data-tooltip-delay'),
            placement: dotEl.getAttribute('data-tooltip-position'),
            ourTooltipEls: document.querySelectorAll('.tooltip').length,
          }
        : null,
      negativeYCount: ys.filter((y) => y < 0).length,
      /*
       * y 눈금 글자가 플롯 왼쪽 밖으로 나가면 앞자리가 뷰에 잘린다(400행 화면에서 6,000 이 그랬다).
       * 0 이상이면 글자가 상자 안에 온전히 들어온 것이다.
       */
      /*
       * x 눈금 글자가 서로 겹치는지 — 좁은 폭에서 개수를 줄이는 규칙(B1)이 실제로 먹었는지는
       * 글자 상자를 직접 재야 안다. 0 이하가 하나라도 있으면 두 글자가 붙어 한 덩어리로 읽힌다.
       */
      xLabelGap: (function () {
        const els = Array.from(document.querySelectorAll('.bases-plus-graph-axis text'));
        let min = null;
        for (let i = 1; i < els.length; i++) {
          const gap = Math.round(els[i].getBoundingClientRect().left - els[i - 1].getBoundingClientRect().right);
          if (min === null || gap < min) min = gap;
        }
        return min;
      })(),
      yLabelLeft: (function () {
        const plot = document.querySelector('.bases-plus-graph-plot').getBoundingClientRect();
        let min = null;
        document.querySelectorAll('.bases-plus-graph-grid text').forEach(function (el) {
          const at = Math.round(el.getBoundingClientRect().left - plot.left);
          if (min === null || at < min) min = at;
        });
        return min;
      })(),
      topTickY: Math.min.apply(null, ys),
      /*
       * 숨은 점은 세지 않는다 — 직렬화된 인라인 스타일은 공백 없는 display:none 이라 속성 선택자로는
       * 안 걸린다. 실제로 그려지는지는 computed 값이 답한다(범례로 감춘 시리즈가 여기서 드러난다).
       */
      dots: Array.from(document.querySelectorAll('.bases-plus-graph-dot')).filter(
        (el) => getComputedStyle(el).display !== 'none'
      ).length,
      paths: document.querySelectorAll('.bases-plus-graph-line').length,
      hoverOnly: document.querySelector('.bases-plus-graph-dots').classList.contains('is-hover-only'),
      /*
       * x 창의 스크롤 띠 — 여기서는 **진짜 스크롤 컨테이너**라 손잡이 비율까지 브라우저가 낸 값으로 잰다.
       * 창이 없으면 요소째 감춰야 한다(못 쓰는 컨트롤을 세워 두지 않는다).
       */
      rail: (function () {
        const el = document.querySelector('.bases-plus-graph-rail');
        if (!el) return null;
        const shown = getComputedStyle(el).display !== 'none';
        if (!shown) return { shown: false };
        return {
          shown: true,
          height: getComputedStyle(el).height,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          scrollLeft: Math.round(el.scrollLeft),
          scrollable: el.scrollWidth > el.clientWidth,
          // 손잡이가 전체의 얼마인가 = 지금 보고 있는 비율.
          thumbRatio: Math.round((el.clientWidth / el.scrollWidth) * 100) / 100,
          // 축과 나란한가 — 왼쪽 눈금 글자 폭만큼 안쪽에서 시작해야 한다.
          startsAtPlot: Math.round(el.getBoundingClientRect().left - document.querySelector('.bases-plus-graph-plot').getBoundingClientRect().left),
        };
      })(),
      notice: (function () {
        const el = document.querySelector('.bases-plus-notice');
        return el ? { shown: getComputedStyle(el).display !== 'none', text: el.textContent } : null;
      })(),
      // 가로 넘침은 clientWidth 로 잰다 — innerWidth 는 헤드리스 스크롤바를 포함해 넘침을 놓친다.
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      /*
       * 뷰가 스크롤바를 얻는지 — 캔버스가 상자보다 1px 만 넓어도 가로 스크롤바가 생기고, 그 15px 이
       * 플롯 높이에서 빠진다(무대 실측: 폭을 900 으로 심었을 때 209, 실제 폭 883 으로 심었을 때 224).
       */
      viewScroll: (function () {
        const el = document.querySelector('.bases-view');
        return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
      })(),
    };
  }

  document.getElementById('probe').textContent = JSON.stringify(result, null, 1);
})();
`;

// ── FakeEl → HTML ─────────────────────────────────────────────────────────────────────
function esc(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** setCssStyles 로 들어간 인라인 스타일(열 폭 등)까지 실어야 실물과 같아진다. */
function serialize(el) {
	const cls = Array.from(el.classes).join(' ');
	const attrs = Object.keys(el.attrs)
		.filter((k) => el.attrs[k] !== null && el.attrs[k] !== undefined)
		.map((k) => ` ${k}="${esc(el.attrs[k])}"`)
		.join('');
	const declarations = Object.keys(el.style)
		.filter((name) => el.style[name] !== '' && el.style[name] !== undefined)
		.map((name) => `${name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${el.style[name]}`);
	if (el.hidden) declarations.push('display:none');

	const style = declarations.length ? ` style="${esc(declarations.join(';'))}"` : '';
	// 입력칸의 현재 값은 attr 이 아니라 프로퍼티로 들어간다(inputEl.value = ...) — 화면에 글자가 보이게 실어 준다.
	// input 은 value 속성으로, **textarea 는 내용으로** 실어야 한다(속성으로 주면 빈 칸으로 그려진다).
	//
	// setIcon 스텁은 요소를 안 만들고 이름만 남긴다 — 여기서 실물과 같은 `svg.svg-icon` 을 세워
	// 코어의 아이콘 치수 규칙(app.css:7921)이 그대로 걸리게 한다. 그래야 버튼 상자·글리프 축을 잰다.
	const inner = el.tag === 'textarea'
		? esc(el.value || '')
		: el.text
			? esc(el.text)
			: el.children.length
				? el.children.map(serialize).join('')
				: el.iconName ? '<svg class="svg-icon"></svg>' : '';
	const value = el.tag === 'input' && el.value ? ` value="${esc(el.value)}"` : '';
	// disabled 는 프로퍼티로만 세워진다(실물 button 은 속성으로 되비춘다) — 여기서 그 반영을 대신한다.
	const disabled = el.tag === 'button' && el.disabled ? ' disabled' : '';
	const open = `<${el.tag}${cls ? ` class="${esc(cls)}"` : ''}${attrs}${value}${disabled}${style}>`;

	return el.tag === 'input' ? open : `${open}${inner}</${el.tag}>`;
}

// ── 크로미움 ──────────────────────────────────────────────────────────────────────────
function findChrome() {
	if (process.env.CHROME) return process.env.CHROME;

	const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
	if (!fs.existsSync(cacheDir)) return null;

	/*
	 * **캡처는 chrome-headless-shell 빌드로만 된다** — 풀 Chrome for Testing 은 `--screenshot` 에서
	 * 라스터화를 마치지 못하고 멈춘다(실측). probe(--dump-dom)는 둘 다 되므로 shell 을 먼저 찾고
	 * 없을 때만 풀 빌드로 내려간다.
	 */
	const candidates = [
		['chromium_headless_shell-', ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac'], 'chrome-headless-shell'],
		['chromium-', ['chrome-mac-arm64', 'chrome-mac'], path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')],
	];

	for (const [prefix, arches, exeName] of candidates) {
		const builds = fs.readdirSync(cacheDir).filter((n) => n.startsWith(prefix)).sort().reverse();
		for (const build of builds) {
			for (const arch of arches) {
				const exe = path.join(cacheDir, build, arch, exeName);
				if (fs.existsSync(exe)) return exe;
			}
		}
	}

	return null;
}

function runChrome(args) {
	const chrome = findChrome();
	if (!chrome) throw new Error('크로미움을 못 찾았다 — CHROME 환경변수로 실행 파일 경로를 주거나 `npx playwright install chromium` 을 돌린다');

	return cp.execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000', ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
}

// ── 진입점 ────────────────────────────────────────────────────────────────────────────
async function main() {
	const args = process.argv.slice(2);
	const mode = args.find((a) => !a.startsWith('--')) || 'table';
	const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	const flagValue = (name, fallback) => {
		const found = flag(name);
		if (!found) return fallback;
		const at = found.indexOf('=');
		return at === -1 ? fallback : found.slice(at + 1);
	};

	if (!MODES[mode]) throw new Error(`모르는 모드: ${mode} (${Object.keys(MODES).join(' · ')})`);

	// 화면 언어 — `--lang=ko` 면 우리 컨트롤 문구가 한글로 나온다(실물은 옵시디언 설정을 읽는다).
	if (typeof stub.setLanguage === 'function') stub.setLanguage(flagValue('lang', 'en'));
	if (!fs.existsSync(APP_CSS)) throw new Error(`app.css 가 없다 — 먼저 돌린다: node ${path.relative(process.cwd(), path.join(__dirname, 'extract-app-assets.cjs'))}`);
	if (!fs.existsSync(BUNDLE)) throw new Error('main.js 가 없다 — 먼저 `npm run build`');

	fs.mkdirSync(OUT_DIR, { recursive: true });

	const html = buildPage(await MODES[mode](), {
		mode,
		dark: !!flag('dark'),
		sim: !!flag('sim'),
		width: flagValue('width', '900px'),
	});
	const pagePath = path.join(OUT_DIR, `${mode}.html`);
	fs.writeFileSync(pagePath, html);
	console.log('페이지:', pagePath);

	if (flag('probe')) {
		const dom = runChrome(['--dump-dom', `file://${pagePath}`]);
		const match = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
		console.log(match ? match[1].replace(/&quot;/g, '"') : '(probe 결과 없음)');
	}

	if (flag('shot')) {
		const shotPath = path.resolve(OUT_DIR, flagValue('shot', `${mode}.png`));
		const height = { compare: 330, modal: 620, embed: 380, paged: 220, ordering: 200, grouped: 240, valueOrder: 320, timeline: 260, timelineWide: 260, timelineScrolled: 260, timelineScrolledGroup: 340, timelineOrdering: 260, timelineFill: 260, timelineWeek: 260, timelineGroupOrder: 340, timelineRegression: 900, timelineWeekWide: 260, timelineColorModal: 360, timelineColor: 260, timelineGrouped: 340, calendar: 700, calendarStates: 760, calendarExpanded: 740, calendarWeek: 340, calendarEmbed: 340, calendarPicker: 380, calendarPlain: 700, graph: 300, graphDense: 300, graphSeries: 300, graphEmpty: 120, graphEmbed: 300, graphLegendOff: 300, graphWindow: 300 }[mode] || 240;
		runChrome([`--window-size=${parseInt(flagValue('width', '900px'), 10) + 20},${height}`, `--screenshot=${shotPath}`, `file://${pagePath}`]);
		console.log('스크린샷:', shotPath);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
