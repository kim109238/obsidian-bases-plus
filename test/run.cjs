'use strict';

const Module = require('module');
const stub = require('./obsidian-stub.cjs');

const BUNDLE = require('path').join(__dirname, '..', 'main.js');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'obsidian') return stub;
	return originalLoad.call(this, request, parent, isMain);
};

const { FakeEl, Modal, Menu, WorkspaceLeaf, Notice, Platform, Setting, TFile, BasesView, BasesQueryResult } = stub;

// attachFileMenu 가 전역 document 를 본다 — 노드에는 없으므로 최소 스텁을 깔아 둔다.
function makeDoc() {
	const doc = {
		listeners: [],
		addEventListener(type, cb) { this.listeners.push({ type, cb }); },
		removeEventListener(type, cb) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.cb === cb)); },
		rightClick(target) { this.listeners.filter((l) => l.type === 'contextmenu').forEach((l) => l.cb({ type: 'contextmenu', target })); },
	};
	return doc;
}
global.document = makeDoc();
// 타이머는 팝아웃 창까지 살도록 `window.setTimeout` 으로 부른다(공식 lint `prefer-window-timers`) —
// 실물에는 늘 있는 전역이라 노드에도 같은 자리를 세운다. 없으면 그 경로가 하네스에서만 터진다.
global.window = { setTimeout, clearTimeout, setInterval, clearInterval };

/** `.bases-view[data-view-type=...]` 안을 우클릭한 것처럼 보이는 대상. */
function targetInBasesView(viewType) {
	const viewEl = { getAttribute: (k) => (k === 'data-view-type' ? viewType : null) };
	return { closest: (sel) => (sel === '.bases-view' ? viewEl : null) };
}
const targetOutside = { closest: () => null };

let pass = 0;
const failures = [];
function check(name, condition, detail) {
	if (condition) { pass++; console.log(`  ok   ${name}`); }
	else { failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeApp(configValue, vaultConfig, propertyTypes) {
	const opened = { tabs: [], popouts: [] };
	const handlers = {};
	/** 파일별 프론트매터 — 인라인 편집이 실제로 무엇을 쓰는지 본다. */
	const frontmatter = {};
	const types = propertyTypes || {};
	const app = {
		renderContext: {},
		/**
		 * 비공개 표면이지만 실물이 늘 있는 객체다. 계약도 실물과 같게 둔다 — 이름을 소문자로 낮춰 찾고
		 * **못 찾으면 null 이 아니라 `{ widget: 'text' }`** 를 돌려준다(1.13.4 app.js `getPropertyInfo`).
		 */
		metadataTypeManager: {
			getPropertyInfo: (key) => ({
				name: key,
				widget: types[String(key).toLowerCase()] || 'text',
				occurrences: 0,
			}),
		},
		/**
		 * 연관 파일이 쓰는 표면 — 전부 d.ts 공개다. 볼트는 테스트가 `vault.files` 에 채워 넣고,
		 * 링크 캐시는 `metadataCache.caches[경로]` 에 넣는다. `resolvedLinks` 는 백링크 역인덱스의 원본이다.
		 */
		metadataCache: {
			caches: {},
			resolvedLinks: {},
			getFileCache(file) { return this.caches[file?.path] || null; },
			getFirstLinkpathDest(linkpath, sourcePath) {
				const files = app.vault.files;
				return (
					files[linkpath] ||
					files[linkpath + '.md'] ||
					files['notes/' + linkpath + '.md'] ||
					null
				);
			},
			fileToLinktext(file) { return file.basename; },
			on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return { name, cb }; },
			offref() {},
			trigger(name, ...args) { (handlers[name] || []).forEach((cb) => cb(...args)); },
		},
		vault: {
			files: {},
			/** 노트 본문 — 달력 태스크가 이 자리를 읽는다. 테스트가 경로별로 채워 넣는다. */
			contents: {},
			/** 실제로 읽은 파일 경로. **몇 번 읽었는지**가 성능 판정의 근거다(성1). */
			reads: [],
			getConfig: (key) => {
				if (key === 'propertiesInDocument') return configValue;
				return (vaultConfig || {})[key];
			},
			getFileByPath(path) { return this.files[path] || null; },
			/** d.ts 공개(`@since 0.9.7`). 실물처럼 Promise 를 돌려준다 — 동기로 두면 2단 구조가 안 드러난다. */
			async cachedRead(file) {
				this.reads.push(file.path);
				return this.contents[file.path] || '';
			},
			on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return { name, cb }; },
			offref() {},
			trigger(name, ...args) { (handlers[name] || []).forEach((cb) => cb(...args)); },
		},
		fileManager: {
			async processFrontMatter(file, fn) {
				const current = frontmatter[file.path] || (frontmatter[file.path] = {});
				fn(current);
			},
			async renameFile(file, path) { opened.renamed = { file, path }; file.path = path; },
		},
		workspace: {
			on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return { name, cb }; },
			/** 실물 `Workspace` 는 `Events` 를 상속해 늘 갖고 있다 — 없는 것으로 두면 unload 가 스텁에서만 터진다. */
			offref(ref) {
				if (!ref || !handlers[ref.name]) return;
				handlers[ref.name] = handlers[ref.name].filter((cb) => cb !== ref.cb);
			},
			trigger(name, ...args) { (handlers[name] || []).forEach((cb) => cb(...args)); },
			getLeaf(kind) { return { kind, openFile: async (file) => { opened.tabs.push({ kind, file }); } }; },
			openPopoutLeaf() { return { openFile: async (file) => { opened.popouts.push(file); } }; },
			/** 속성 설정 화면으로 보내는 경로 — 전부 공개 API 다(getRightLeaf·setViewState·revealLeaf). */
			getRightLeaf(split) {
				if (opened.noRightLeaf) return null;
				opened.rightLeaf = { split, setViewState: async (state) => { opened.viewState = state; } };
				return opened.rightLeaf;
			},
			async revealLeaf(leaf) { opened.revealed = leaf; },
		},
	};
	return { app, opened, handlers, frontmatter };
}

function makeFile(name) {
	const file = new TFile();
	file.basename = name;
	file.name = name + '.md';
	file.path = 'notes/' + name + '.md';
	file.extension = 'md';
	return file;
}

/**
 * 값 스텁 — 실물 `Value` 처럼 renderTo 로 마크업을 남기고, 생성자의 static `type` 이 값 타입이 된다
 * (셀의 data-value-type 이 이 값을 읽는다).
 */
class StubValue {
	constructor(render) { this.render = render; }
	renderTo(el, ctx) { this.render(el, ctx); }
}
class StringValue extends StubValue {}
StringValue.type = 'String';
class NumberValue extends StubValue {}
NumberValue.type = 'Number';
class FileValue extends StubValue {}
FileValue.type = 'File';

class NullValueStub extends StubValue {}
NullValueStub.type = 'Null';
class DateValueStub extends StubValue {}
DateValueStub.type = 'Date';
class ListValueStub extends StubValue {}
ListValueStub.type = 'List';
class LinkValueStub extends StubValue {}
LinkValueStub.type = 'Link';
class BooleanValueStub extends StubValue {}
BooleanValueStub.type = 'Boolean';

// 실물 Value 는 전부 toString() 을 갖는다 — 편집기가 화면 글자가 아니라 값에서 현재 값을 읽으므로 스텁도 같아야 한다.
const textValue = (text) => Object.assign(new StringValue((el) => el.setText(text)), { toString: () => text });
/** 빈 값 — 실물 NullValue 는 toString() 이 문자열 "null" 이고 renderTo 가 아무것도 안 그린다. */
const nullValue = () => Object.assign(new NullValueStub(() => {}), { toString: () => 'null' });
/** 실물 DateValue 처럼 비활성 입력으로 그린다 — 화면 텍스트가 비어 값 읽기 경로가 드러난다. */
const dateValue = (iso) =>
	Object.assign(
		new DateValueStub((el) => el.createEl('input', { attr: { type: 'date', value: iso, disabled: true } })),
		{ toString: () => iso }
	);
/** 실물 ListValue 는 항목을 하나씩 내주고(`length()`·`get()` — 둘 다 d.ts 공개) toString() 은 ", " 로 잇는다. */
const listValue = (items) =>
	Object.assign(new ListValueStub((el) => el.setText(items.join(', '))), {
		toString: () => items.join(', '),
		length: () => items.length,
		get: (index) => items[index],
	});
/** 항목을 못 세는 목록 — `toString()` 을 쉼표로 나누는 대비 경로를 태운다. */
const opaqueListValue = (text) =>
	Object.assign(new ListValueStub((el) => el.setText(text)), { toString: () => text });
/** 링크는 화면에 별칭이 보이고 저장 원문은 `[[...]]` 다. */
const linkValue = (raw, display) =>
	Object.assign(new LinkValueStub((el) => el.createSpan({ cls: 'internal-link', text: display })), {
		toString: () => raw,
	});
const numberValue = (n) => Object.assign(new NumberValue((el) => el.setText(String(n))), { toString: () => String(n) });
/** 실물 BooleanValue 는 체크박스 입력으로 그려진다 — 화면 텍스트가 비어 값 읽기 경로가 드러난다. */
const boolValue = (on) =>
	Object.assign(
		new BooleanValueStub((el) => el.createEl('input', { attr: { type: 'checkbox', checked: on, disabled: true } })),
		{ toString: () => String(on) }
	);
/** 네이티브 file.file 렌더와 같은 산출물 — 파일 링크 스팬. */
const fileValue = (name) => new FileValue((el) => el.createSpan({ cls: 'internal-link', text: name }));

function makeEntry(name, values) {
	const map = values || {};
	return {
		file: makeFile(name),
		getValue: (prop) => (Object.prototype.hasOwnProperty.call(map, prop) ? map[prop] : null),
	};
}

function makeEntryWithValue(name) {
	return makeEntry(name, { 'file.file': fileValue(name) });
}

function resetStubs() {
	Modal.instances.length = 0;
	Menu.instances.length = 0;
	WorkspaceLeaf.instances.length = 0;
	Notice.messages.length = 0;
	Setting.built.length = 0;
	BasesView.created.length = 0;
	WorkspaceLeaf.constructorThrows = false;
	WorkspaceLeaf.openFileThrows = false;
	Platform.isDesktopApp = true;
	global.document = makeDoc();
	// 화면 언어는 구획마다 영어로 되돌린다 — 한 구획의 한국어가 다음 구획의 문구 단언을 깨뜨리지 않게.
	stub.setLanguage('en');
}

/** 표시 속성을 안 넘기면 파일 이름 한 열 — 네이티브 getOrder() 기본값과 같다. */
const DEFAULT_PROPS = ['file.name'];

async function mount(app, entries, viewConfig, settings, properties) {
	const exported = require(BUNDLE);
	const PluginClass = exported.default || exported;
	const plugin = new PluginClass(app, { id: 'bases-plus' });
	if (settings) plugin.loadData = async () => settings;
	await plugin.onload();

	const registration = plugin.basesViews[0].registration;
	const containerEl = new FakeEl('div', 'bases-view');
	containerEl.addClass('is-loading');
	const config = makeConfig(viewConfig);

	// 실물 순서 그대로다(app.js 오프셋 2500709·2502560): 팩토리에는 컨트롤러만 넘어가고 config 는 그 **뒤에** 붙는다.
	// 그다음 갱신마다 allProperties·data 를 세우고 onDataUpdated 를 부른다. 순서를 바꾸면 T27 같은 결함을 놓친다.
	const view = registration.factory({ app }, containerEl);
	view.config = config;
	view.allProperties = properties || DEFAULT_PROPS;
	view.data = new BasesQueryResult(entries, properties || DEFAULT_PROPS);
	view.onDataUpdated();
	return { plugin, view, containerEl, registration, config };
}

/**
 * `.base` 뷰 설정 — 실물처럼 값을 실제로 담아 둔다(열 폭·접힘·순서 저장 검증에 쓴다). null 저장은 삭제다.
 *
 * `overrides.stored` 로 초기값을 심으면 **읽기와 쓰기가 같은 자리를 본다** — 접힘·수동 순서처럼
 * 우리가 쓴 값을 곧바로 다시 읽는 기능은 이 방식이라야 실물과 같은 경로를 탄다.
 * (`overrides.get` 을 직접 넘기면 그 자리만 갈아 끼우므로 읽기 전용 시나리오에만 쓴다.)
 */
function makeConfig(overrides) {
	const stored = Object.assign({}, (overrides || {}).stored);
	const config = {
		get: (key) => stored[key],
		set: (key, value) => { if (value === null) delete stored[key]; else stored[key] = value; },
		// 실물은 base 에서 바꾼 이름을 돌려준다 — 여기선 접두사만 뗀다.
		getDisplayName: (prop) => prop.slice(prop.indexOf('.') + 1),
		/** 실물처럼 문자열일 때만 속성 id 로 돌려주고 아니면 null 이다(타임라인 날짜·색 옵션이 이 경로다). */
		getAsPropertyId: (key) => (typeof stored[key] === 'string' && stored[key] !== '' ? stored[key] : null),
	};
	return Object.assign(config, overrides || {}, { stored });
}

const wait = () => new Promise((resolve) => setImmediate(resolve));
const rowEl = (containerEl, i) => containerEl.findAll('bases-plus-row')[i || 0];
const cellEls = (rowEl) => rowEl.findAll('bases-plus-cell').filter((el) => !el.hidden);
const headerEls = (containerEl) => containerEl.findAll('bases-plus-th').filter((el) => !el.hidden);
const resizerEl = (containerEl, i) => headerEls(containerEl)[i || 0].find('bases-plus-th-resizer');
/** 코어가 그린 파일 링크 위를 눌렀을 때의 이벤트 대상. `closest` 로 링크 안인지 판별한다. */
const linkTarget = { closest: (sel) => (sel.indexOf('internal-link') !== -1 ? {} : null) };
const plainTarget = { closest: () => null };
/** 이름 열 링크 클릭 — 이 뷰의 열기 진입점(네이티브 표와 같은 자리). */
const clickName = (containerEl, i, evt) =>
	cellEls(rowEl(containerEl, i || 0))[0].dispatch('click', Object.assign({ target: linkTarget }, evt || {}));
const valueEl = (rowEl, i) => cellEls(rowEl)[i].children[0];
/** 값 요소는 평문일 수도(setText) 마크업일 수도(renderTo) 있다 — 둘 다 훑는다. */
const textOf = (el) => el.text || el.children.map(textOf).join('');
const cellText = (rowEl, i) => textOf(valueEl(rowEl, i));
/** 헤더 문구는 라벨 안의 이름 조각이 갖는다 — 라벨에는 유형 아이콘도 함께 들어 있다. */
const headerTexts = (containerEl) =>
	headerEls(containerEl).map((el) => el.find('bases-plus-th-name').text);
const headerIcons = (containerEl) =>
	headerEls(containerEl).map((el) => el.find('bases-plus-th-icon').iconName);
/** 목록 편집기의 알약 문구. */
const pillTexts = (cellEl) =>
	cellEl.findAll('multi-select-pill').map((el) => el.find('multi-select-pill-content').text);

/** 뷰 푸터 — 넘길 것이 없으면 요소 자체가 붙어 있지 않다(빈 30px 띠를 남기지 않는다). */
const footerOf = (containerEl) => containerEl.find('bases-plus-footer');
const pagerTextOf = (barEl) => (barEl ? barEl.find('bases-plus-pager-page').text : null);
const viewPagerText = (containerEl) => pagerTextOf(footerOf(containerEl));
const pagerButtons = (barEl) => barEl.findAll('bases-plus-pager-button');
const visibleRowEls = (containerEl) => containerEl.findAll('bases-plus-row').filter((el) => !el.hidden);
const headingEls = (containerEl) =>
	containerEl.findAll('bases-plus-group-heading').filter((el) => !el.hidden);
const groupFooterEls = (containerEl) =>
	containerEl.findAll('bases-plus-group-footer').filter((el) => !el.hidden);
/** 순서 손잡이는 절대 배치라 셀들 **뒤**에 있다 — 자리를 이 헬퍼로 확인한다. */
const handleOf = (el) => el.find('bases-plus-order-handle');
/** 레이아웃이 없는 하네스에 세로 좌표를 심는다 — 드래그가 드롭 자리를 이 값으로 잡는다. */
const layoutRows = (els, height) => {
	els.forEach((el, i) => {
		el.offsetTop = i * (height || 30);
		el.offsetHeight = height || 30;
	});
};

async function main() {
	console.log('\n[1] 플러그인 등록·렌더');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { plugin, view, containerEl, registration } = await mount(app, [makeEntry('Note A'), makeEntry('Note B')]);

		check('진입점이 default export 로 나온다', typeof (require(BUNDLE).default) === 'function');
		check('registerBasesView 가 bases-plus-table 로 불린다', plugin.basesViews[0].id === 'bases-plus-table');
		check('is-loading 이 onDataUpdated 에서 벗겨진다', !containerEl.hasClass('is-loading'));
		check('컨테이너 자식 노드가 0 이 아니다', containerEl.countNodes() > 0, 'nodes=' + containerEl.countNodes());
		check('행이 항목 수만큼 생긴다', containerEl.findAll('bases-plus-row').length === 2);

		const options = registration.options(makeConfig());
		const dropdown = options.find((o) => o.key === 'openMode');
		check('뷰 옵션에 openMode 드롭다운이 있다', !!dropdown && dropdown.type === 'dropdown');
		check('openMode 기본값이 modal 이다', dropdown.default === 'modal');
		check('openMode 선택지가 3개다', Object.keys(dropdown.options).join(',') === 'modal,tab,window');
		check('pageSize 는 직접 입력칸이다 (슬라이더 아님)', options.find((o) => o.key === 'pageSize').type === 'text');

		// 행 제한은 **드롭다운 하나**다 — F3(전체 페이징)·F10(그룹 페이징) 배타가 UI 구조 자체가 되어
		// 잘못된 조합이 표현조차 안 된다(디자인 B1 · 확정 1).
		const rowLimit = options.find((o) => o.key === 'rowLimit');
		check('행 제한이 드롭다운 하나다', !!rowLimit && rowLimit.type === 'dropdown');
		check('행 제한 선택지가 4종이다', Object.keys(rowLimit.options).join(',') === 'all,pages,group-top,group-pages', Object.keys(rowLimit.options).join(','));
		check('선택지 문구가 명세 그대로다', Object.values(rowLimit.options).join('|') === 'Show all|Pages|Top rows per group|Pages per group', Object.values(rowLimit.options).join('|'));
		check('기본이 Show all 이다 (예전 켜짐에서 바뀐다)', rowLimit.default === 'all');
		check('예전 limitRows 토글은 옵션에서 빠졌다', options.find((o) => o.key === 'limitRows') === undefined);
		check('그룹 계열이 쓰는 숫자 칸이 따로 있다', options.find((o) => o.key === 'groupSize').type === 'text');

		const manual = options.find((o) => o.key === 'manualOrderEnabled');
		check('수동 순서 토글이 있고 기본이 꺼짐이다', !!manual && manual.type === 'toggle' && manual.default === false);
		check('옵션 순서가 명세 G1 + 그룹 수동 순서다', options.map((o) => o.key).join(',') === 'openMode,rowLimit,pageSize,groupSize,manualOrderEnabled,groupOrderEnabled', options.map((o) => o.key).join(','));
		view.unload();
	}

	console.log('\n[2] 갱신 시 DOM·리스너 재사용');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A'), makeEntry('Note B')]);
		const firstRows = containerEl.findAll('bases-plus-row');
		const firstCells = cellEls(firstRows[0]);
		const before = firstRows[0].listeners.length;

		view.data = { data: [makeEntry('Note A2'), makeEntry('Note B2'), makeEntry('Note C2')], properties: DEFAULT_PROPS };
		view.onDataUpdated();
		const secondRows = containerEl.findAll('bases-plus-row');
		const after = secondRows[0].listeners.length;

		check('기존 행 요소를 재사용한다', secondRows[0] === firstRows[0] && secondRows[1] === firstRows[1]);
		check('기존 셀 요소를 재사용한다', cellEls(secondRows[0])[0] === firstCells[0]);
		check('늘어난 만큼만 행을 새로 만든다', secondRows.length === 3);
		check('갱신해도 리스너가 누적되지 않는다', after === before, `${before} -> ${after}`);
		check('값 셀만 다시 그린다', cellText(secondRows[0], 0) === 'Note A2');

		view.data = { data: [makeEntry('Note A3')], properties: DEFAULT_PROPS };
		view.onDataUpdated();
		check('남는 행은 감춘다', containerEl.findAll('bases-plus-row')[1].hidden === true);
		view.unload();
	}

	console.log('\n[3] renderTo 경로');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntryWithValue('Linked')]);
		const valueEl = containerEl.find('bases-plus-value');
		check('값이 있으면 renderTo 산출물을 쓴다', valueEl.children.length === 1 && valueEl.children[0].hasClass('internal-link'));
		check('값 요소에 bases-rendered-value 를 붙인다', valueEl.hasClass('bases-rendered-value'));
		check('file.name 열은 파일 링크(file.file)로 그린다', containerEl.find('bases-plus-cell').attrs['data-property'] === 'file.name');
		view.unload();
	}

	console.log('\n[4] 뷰 옵션이 진입점을 지배한다 (D21)');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		check('기본값이면 행 클릭 한 번에 모달이 뜬다', Modal.instances.length === 1 && Modal.instances[0].isOpen);
		Modal.instances[0].close();
		view.unload();
	}

	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'openMode' ? 'tab' : undefined) });

		clickName(containerEl);
		await wait();
		check('openMode=tab 이면 모달 대신 탭을 연다', Modal.instances.length === 0 && opened.tabs.length === 1);
		view.unload();
	}

	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'openMode' ? 'window' : undefined) });
		clickName(containerEl);
		await wait();
		check('openMode=window 면 팝아웃을 연다', opened.popouts.length === 1 && opened.tabs.length === 0);
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'openMode' ? 'garbage' : undefined) });
		clickName(containerEl);
		await wait();
		check('모르는 값이면 기본값(modal)으로 되돌린다', Modal.instances.length === 1);
		Modal.instances[0].close();
		view.unload();
	}

	console.log('\n[5] 모달 — 리프 임베드');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();

		check('분리된 leaf 를 만든다', WorkspaceLeaf.instances.length === 1);
		check('그 leaf 로 파일을 연다', WorkspaceLeaf.instances[0].opened[0].state.active === false);
		check('모달이 열린다', Modal.instances.length === 1 && Modal.instances[0].isOpen);
		// 임베드한 편집기가 이미 제목을 보여 준다 — 모달 제목을 넣으면 두 줄로 겹친다(마스터 실기동 피드백).
		// 코어 titleEl 이 비었다는 것만으로는 '우리가 아무 데도 제목을 안 넣었다'가 증명되지 않는다 — 요소 부재를 본다.
		check('마크다운 모달에는 제목 요소 자체가 없다', Modal.instances[0].contentEl.find('bases-plus-modal-title') === null && Modal.instances[0].titleEl.text === '');
		check('모달에 bases-plus-note-modal 클래스가 붙는다', Modal.instances[0].modalEl.hasClass('bases-plus-note-modal'));
		check('편집기 컨테이너가 모달 안으로 옮겨진다', Modal.instances[0].contentEl.find('bases-plus-modal-leaf').children[0] === WorkspaceLeaf.instances[0].view.containerEl);
		check('속성 안내는 visible 일 때 안 뜬다', Modal.instances[0].contentEl.find('bases-plus-modal-notice') === null);

		const actions = Modal.instances[0].contentEl.find('bases-plus-modal-actions');
		check('모달에 새 탭·새 창 버튼 2개가 있다 (F6 경로)', actions.children.length === 2);
		check('버튼이 탭·새 창 순이다', actions.children.map((el) => el.attrs['aria-label']).join('|') === 'Open in new tab|Open in new window');

		Modal.instances[0].close();
		check('모달을 닫으면 leaf 를 뗀다', WorkspaceLeaf.instances[0].detached === true);
		check('모달을 닫으면 내용을 비운다', Modal.instances[0].contentEl.children.length === 0);
		view.unload();
	}

	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		Modal.instances[0].contentEl.find('bases-plus-modal-actions').children[0].dispatch('click');
		await wait();
		check('모달의 새 탭 버튼이 모달을 닫고 탭을 연다', Modal.instances[0].isOpen === false && opened.tabs.length === 1);
		view.unload();
	}

	console.log('\n[6] 모달 폴백');
	resetStubs();
	{
		WorkspaceLeaf.constructorThrows = true;
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();

		check('생성자가 막히면 모달을 띄우지 않는다', Modal.instances.length === 0);
		check('새 탭으로 폴백한다', opened.tabs.length === 1 && opened.tabs[0].kind === 'tab');
		check('폴백을 사용자에게 알린다', Notice.messages.length === 1);
		view.unload();
	}

	resetStubs();
	{
		WorkspaceLeaf.openFileThrows = true;
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		check('openFile 이 실패해도 폴백한다', Modal.instances.length === 0 && opened.tabs.length === 1);
		check('실패한 leaf 를 정리한다', WorkspaceLeaf.instances[0].detached === true);
		view.unload();
	}

	console.log('\n[7] 속성 편집 안내');
	for (const setting of ['hidden', 'source']) {
		resetStubs();
		const { app } = makeApp(setting);
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		const notice = Modal.instances[0].contentEl.find('bases-plus-modal-notice');
		// 안내는 설정 값(hidden)이 아니라 **설정 화면에 뜨는 이름**(Hidden)을 말한다 — 한글에서는 숨김·원본이 된다.
		const shown = setting === 'hidden' ? 'Hidden' : 'Source';
		check(`propertiesInDocument=${setting} 이면 안내가 뜬다`, notice !== null && notice.text.indexOf(shown) !== -1, notice && notice.text);
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		delete app.vault.getConfig;
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		check('getConfig 이 없어도 모달은 열린다', Modal.instances.length === 1 && Modal.instances[0].isOpen);
		check('그때 안내는 생략된다', Modal.instances[0].contentEl.find('bases-plus-modal-notice') === null);
		view.unload();
	}

	console.log('\n[8] 우리 뷰 행 우클릭 — 1항목 (D21)');
	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'openMode' ? 'tab' : undefined) });
		const row = containerEl.findAll('bases-plus-row')[0];

		row.dispatch('contextmenu');
		check('메뉴가 뜬다', Menu.instances.length === 1 && Menu.instances[0].shown);
		check('항목이 1개다', Menu.instances[0].items.length === 1);
		check('제목이 Open with Bases Plus 다', Menu.instances[0].items[0].title === 'Open with Bases Plus');
		check('open 섹션에 붙는다', Menu.instances[0].items[0].section === 'open');
		check('아이콘이 뷰 옵션 방식을 따른다', Menu.instances[0].items[0].icon === 'file-plus');

		Menu.instances[0].items[0].click();
		await wait();
		check('누르면 뷰 옵션 방식으로 연다', opened.tabs.length === 1);

		Menu.instances.length = 0;
		row.dispatch('contextmenu', { defaultPrevented: true });
		check('링크 위 우클릭(defaultPrevented)엔 메뉴를 겹치지 않는다', Menu.instances.length === 0);
		view.unload();
	}

	console.log('\n[9] 네이티브 뷰 우클릭 부착 (D21 · N1)');
	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view } = await mount(app, [makeEntry('Note A')]);
		const file = makeFile('Native');

		let menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'bases-context-menu');
		check('내장 표 셀 우클릭에 1항목이 붙는다', menu.items.length === 1 && menu.items[0].title === 'Open with Bases Plus');
		check('아이콘이 설정 기본값(modal)을 따른다', menu.items[0].icon === 'maximize');

		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		check('Bases 밖 링크 우클릭엔 붙지 않는다', menu.items.length === 0);

		global.document.rightClick(targetInBasesView('cards'));
		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		check('내장 카드 뷰 안 링크엔 붙는다', menu.items.length === 1);

		global.document.rightClick(targetInBasesView('list'));
		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		check('내장 목록 뷰 안 링크엔 붙는다', menu.items.length === 1);

		global.document.rightClick(targetInBasesView('bases-plus-table'));
		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		check('우리 뷰 안에서는 붙지 않는다 (중복 방지)', menu.items.length === 0);

		global.document.rightClick(targetOutside);
		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
		check('.bases-view 밖이면 붙지 않는다', menu.items.length === 0);

		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'file-explorer-context-menu');
		check('파일탐색기 메뉴엔 붙지 않는다', menu.items.length === 0);

		menu = new Menu();
		app.workspace.trigger('file-menu', menu, { path: 'notes' }, 'bases-context-menu');
		check('TFile 이 아니면 붙지 않는다', menu.items.length === 0);

		menu = new Menu();
		app.workspace.trigger('files-menu', menu, [file, makeFile('B')], 'bases-context-menu');
		check('복수 선택(files-menu)엔 붙지 않는다', menu.items.length === 0);

		menu = new Menu();
		app.workspace.trigger('file-menu', menu, file, 'bases-context-menu');
		menu.items[0].click();
		await wait();
		check('누르면 설정 기본값(modal)으로 연다', Modal.instances.length === 1);
		Modal.instances[0].close();
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view } = await mount(app, [makeEntry('Note A')], null, { nativeMenuEnabled: false });
		const menu = new Menu();
		app.workspace.trigger('file-menu', menu, makeFile('Native'), 'bases-context-menu');
		check('설정 토글을 끄면 항목이 사라진다', menu.items.length === 0);
		view.unload();
	}

	resetStubs();
	{
		const { app, opened } = makeApp('visible');
		const { view } = await mount(app, [makeEntry('Note A')], null, { nativeOpenMode: 'window' });
		const menu = new Menu();
		app.workspace.trigger('file-menu', menu, makeFile('Native'), 'bases-context-menu');
		check('설정 방식이 아이콘에 반영된다', menu.items[0].icon === 'picture-in-picture-2');
		menu.items[0].click();
		await wait();
		check('설정 방식대로 새 창을 연다', opened.popouts.length === 1);
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { plugin, view } = await mount(app, [makeEntry('Note A')]);
		const popoutDoc = makeDoc();
		app.workspace.trigger('window-open', {}, { document: popoutDoc });
		popoutDoc.rightClick(targetInBasesView('table'));

		const menu = new Menu();
		app.workspace.trigger('file-menu', menu, makeFile('Native'), 'link-context-menu');
		check('새 창(팝아웃)에서도 우클릭 대상을 추적한다', menu.items.length === 1);
		check('window-open 구독을 registerEvent 로 건다', plugin._registered.length > 0);
		view.unload();
	}

	console.log('\n[10] 모바일 — 새 창 없음');
	resetStubs();
	{
		Platform.isDesktopApp = false;
		const { app, opened } = makeApp('visible');
		const { view, containerEl, registration } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'openMode' ? 'window' : undefined) });

		check('뷰 옵션 선택지에서 새 창을 뺀다', Object.keys(registration.options(makeConfig()).find((o) => o.key === 'openMode').options).join(',') === 'modal,tab');

		clickName(containerEl);
		await wait();
		check('저장된 window 값은 기본값(modal)으로 되돌린다', Modal.instances.length === 1);
		check('모달 액션이 새 탭 1개만 남는다', Modal.instances[0].contentEl.find('bases-plus-modal-actions').children.length === 1);
		check('팝아웃을 부르지 않는다', opened.popouts.length === 0);
		view.unload();
	}

	console.log('\n[11] 설정 탭');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { plugin } = await mount(app, [makeEntry('Note A')]);
		plugin.settingTabs[0].display();
		const kinds = Setting.built.map((s) => s.kind).join(',');
		check('설정 3개가 그려진다 (토글·드롭다운·숫자 입력)', kinds === 'toggle,dropdown,text', kinds);
		check('드롭다운 선택지가 열기 방식 3종이다', Object.keys(Setting.built[1].options).join(',') === 'modal,tab,window');
		check('드롭다운 초기값이 modal 이다', Setting.built[1].value === 'modal');

		// 기본 행 수도 뷰 옵션과 같은 숫자 입력으로 바꿨다.
		const pageSetting = Setting.built[2];
		check('기본 행 수가 숫자 입력칸이다', pageSetting.inputEl.type === 'number' && pageSetting.inputEl.step === '1');
		check('1 단위로 조절되게 하한을 1 로 둔다', pageSetting.inputEl.min === '1');
		check('현재 설정값이 입력칸에 들어간다', pageSetting.value === '50');

		pageSetting.change('7');
		await wait();
		check('입력값을 숫자로 저장한다', plugin.settings.defaultPageSize === 7);
		pageSetting.change('  ');
		await wait();
		check('비우면 기본값(50)으로 되돌린다', plugin.settings.defaultPageSize === 50);
	}

	console.log('\n[12] 표 형태 — 열 헤더·속성 열 (네이티브 패리티)');
	resetStubs();
	{
		const props = ['file.name', 'note.status', 'note.priority'];
		const entries = [
			makeEntry('Note A', { 'file.file': fileValue('Note A'), 'note.status': textValue('진행중'), 'note.priority': numberValue(2) }),
			makeEntry('Note B', { 'file.file': fileValue('Note B'), 'note.status': textValue('대기') }),
		];
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, entries, null, null, props);

		check('열 헤더가 표시 속성 수만큼 생긴다', headerTexts(containerEl).length === 3);
		check('헤더 문구가 config.getDisplayName 이다', headerTexts(containerEl).join('|') === 'name|status|priority', headerTexts(containerEl).join('|'));
		check('헤더에 data-property 를 심는다', containerEl.findAll('bases-plus-th')[1].attrs['data-property'] === 'note.status');

		const first = rowEl(containerEl, 0);
		check('행이 열 수만큼 셀을 갖는다', cellEls(first).length === 3);
		check('셀 값이 속성 순서대로 들어간다', [cellText(first, 0), cellText(first, 1), cellText(first, 2)].join('|') === 'Note A|진행중|2');
		check('셀마다 data-property 를 심는다', cellEls(first)[2].attrs['data-property'] === 'note.priority');
		check('숫자 셀에 값 타입을 심는다 (우측 정렬용)', cellEls(first)[2].attrs['data-value-type'] === 'number');
		check('파일 이름 셀은 링크로 그린다', cellEls(first)[0].children[0].children[0].hasClass('internal-link'));

		const second = rowEl(containerEl, 1);
		check('값이 없는 셀은 비워 둔다', cellText(second, 2) === '' && valueEl(second, 2).children.length === 0);

		// 사용자가 속성 툴바에서 열을 지우면 열 수가 줄어든다.
		view.data = { data: entries, properties: ['file.name', 'note.status'] };
		view.onDataUpdated();
		check('열이 줄면 헤더도 줄어든다', headerTexts(containerEl).length === 2);
		check('열이 줄면 남는 셀은 감춘다', cellEls(rowEl(containerEl, 0)).length === 2);

		view.data = { data: entries, properties: props };
		view.onDataUpdated();
		check('열이 다시 늘면 감췄던 셀을 되살린다', cellEls(rowEl(containerEl, 0)).length === 3);
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], null, null, []);
		check('표시 속성이 비면 파일 이름 한 열로 떨어진다', headerTexts(containerEl).length === 1 && containerEl.find('bases-plus-th').attrs['data-property'] === 'file.name');
		view.unload();
	}

	console.log('\n[13] 이름 클릭 — 열기 진입점 (설계 정정 2 · 2026-08-02 밤)');
	resetStubs();
	{
		const props = ['file.name', 'note.status'];
		const entries = [
			makeEntry('Note A', { 'file.file': fileValue('Note A'), 'note.status': textValue('진행중') }),
			makeEntry('Note B', { 'file.file': fileValue('Note B'), 'note.status': textValue('대기') }),
		];
		const { app, opened } = makeApp('visible');
		const { view, containerEl } = await mount(app, entries, null, null, props);

		const evt = clickName(containerEl, 1);
		await wait();
		check('이름 링크를 누르면 그 행의 파일을 연다', Modal.instances.length === 1 && WorkspaceLeaf.instances[0].opened[0].file.basename === 'Note B');
		// 코어가 링크에 직접 건 리스너는 defaultPrevented 를 보지 않는다 — 전파를 끊지 않으면 한 번 클릭에 두 번 열린다.
		check('링크 리스너에 닿지 않게 전파를 끊는다', evt.propagationStopped === true && evt.defaultPrevented === true);
		Modal.instances[0].close();
		Modal.instances.length = 0;

		// 네이티브 표도 링크 밖(셀 여백)을 누르면 열지 않는다.
		const plain = cellEls(rowEl(containerEl, 0))[0].dispatch('click', { target: plainTarget });
		await wait();
		check('이름 셀이라도 링크 밖을 누르면 열지 않는다', Modal.instances.length === 0 && plain.propagationStopped === false);

		// 다른 열의 링크는 그 링크의 목적지로 가야 한다 — 우리가 가로채면 안 된다.
		cellEls(rowEl(containerEl, 0))[1].dispatch('click', { target: linkTarget });
		await wait();
		check('다른 열의 링크는 가로채지 않는다', Modal.instances.length === 0);

		const modified = clickName(containerEl, 0, { metaKey: true });
		await wait();
		check('수식어 클릭은 코어 링크 동작에 넘긴다', Modal.instances.length === 0 && opened.tabs.length === 0 && modified.propagationStopped === false);

		clickName(containerEl, 0, { button: 2 });
		await wait();
		check('보조 버튼 클릭은 열지 않는다', Modal.instances.length === 0);

		// 네이티브 표의 행도 포커스를 받지 않는다 — T25 의 행 tabindex·Enter 는 이 모델과 맞지 않아 걷어냈다.
		check('행에 tabindex 를 두지 않는다 (네이티브 패리티)', rowEl(containerEl, 0).attrs.tabindex === undefined);
		check('행 우측 액션 아이콘은 두지 않는다 (네이티브 표에 없다)', containerEl.findAll('bases-plus-row-actions').length === 0);
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], { get: (k) => (k === 'pageSize' ? 10 : undefined) });
		view.data = { data: Array.from({ length: 25 }, (_, i) => makeEntry('Note ' + i)), properties: DEFAULT_PROPS };
		view.onDataUpdated();

		check('페이지 크기까지만 그린다', visibleRowEls(containerEl).length === 10);
		// 예전의 "Showing 10 of 25 rows." 는 잘려서 못 보는 행이 있다는 **사과**였다. 페이징이 들어와
		// 잘린 행에 손이 닿으므로 사과할 일이 사라졌다 — 그 자리에 페이저가 선다(A1).
		check('잘리면 넘길 페이저가 선다', viewPagerText(containerEl) === '1 / 3', String(viewPagerText(containerEl)));
		check('사과하던 상태 줄은 없어졌다', containerEl.find('bases-plus-status') === null);

		view.data = { data: [makeEntry('Note A')], properties: DEFAULT_PROPS };
		view.onDataUpdated();
		check('안 잘렸으면 푸터 요소 자체가 없다 (빈 띠를 남기지 않는다)', footerOf(containerEl) === null);
		view.unload();
	}

	console.log('\n[14] 열 폭 조절 — 드래그·저장');
	resetStubs();
	{
		const props = ['file.name', 'note.status', 'note.priority'];
		const entries = [makeEntry('Note A'), makeEntry('Note B')];
		const { app } = makeApp('visible');
		const { view, containerEl, config } = await mount(app, entries, null, null, props);

		const headers = headerEls(containerEl);
		check('열마다 폭 조절 손잡이가 있다', headers.every((el) => el.find('bases-plus-th-resizer') !== null));
		// 8차 4번 — 폭을 안 정한 열은 유동 배분이 아니라 **내용 맞춤**이다(`1 0 Npx`: 남는 자리는 나눠 갖고 내용 아래로는 안 줄어든다).
		// 하네스에는 레이아웃이 없어 잰 값이 0 이라 하한 40px 으로 떨어진다.
		check('폭을 안 정한 열은 내용 맞춤 폭이 된다', headers[0].style.flex === '1 0 40px', headers[0].style.flex);

		// 레이아웃이 없는 하네스라 현재 폭을 직접 넣어 준다 — 실제로는 화면에 그려진 폭이다.
		headers.forEach((el, i) => { el.offsetWidth = [200, 100, 100][i]; });

		const handle = resizerEl(containerEl, 1);
		handle.dispatch('pointerdown', { pointerId: 7, clientX: 300 });
		check('끄는 동안 손잡이에 is-active 가 붙는다', handle.hasClass('is-active'));
		check('포인터를 캡처한다 (창 밖으로 나가도 이어지게)', handle.captured === 7);
		check('끄기 시작하면 모든 열 폭을 굳힌다', headers.map((el) => el.style.flex).join('|') === '0 0 200px|0 0 100px|0 0 100px', headers.map((el) => el.style.flex).join('|'));

		handle.dispatch('pointermove', { pointerId: 7, clientX: 340 });
		check('끈 만큼 그 열이 넓어진다', headers[1].style.flex === '0 0 140px', headers[1].style.flex);
		check('본문 셀도 같은 폭을 따라간다', cellEls(rowEl(containerEl, 0))[1].style.flex === '0 0 140px');
		check('끄는 중에는 옆 열이 움직이지 않는다', headers[0].style.flex === '0 0 200px' && headers[2].style.flex === '0 0 100px');
		check('끄는 중에는 아직 저장하지 않는다', config.stored.columnSize === undefined);

		handle.dispatch('pointermove', { pointerId: 7, clientX: 0 });
		check('최소 폭 아래로는 줄지 않는다', headers[1].style.flex === '0 0 40px', headers[1].style.flex);

		handle.dispatch('pointermove', { pointerId: 99, clientX: 500 });
		check('다른 포인터의 이동은 무시한다', headers[1].style.flex === '0 0 40px');

		handle.dispatch('pointermove', { pointerId: 7, clientX: 340 });
		handle.dispatch('pointerup', { pointerId: 7 });
		check('놓으면 is-active 를 뗀다', handle.hasClass('is-active') === false);
		check('놓으면 포인터 캡처를 푼다', handle.captured === null);
		check('놓을 때 네이티브와 같은 키에 저장한다', !!config.stored.columnSize && config.stored.columnSize['note.status'] === 140, JSON.stringify(config.stored.columnSize));
		check('저장 형태가 속성 id → 픽셀 수다', config.stored.columnSize['file.name'] === 200 && config.stored.columnSize['note.priority'] === 100);

		// 다시 그려도 저장된 폭이 남아야 한다.
		view.data = { data: entries, properties: props };
		view.onDataUpdated();
		check('다시 그려도 폭이 유지된다', headerEls(containerEl)[1].style.flex === '0 0 140px');
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], {
			get: (k) => (k === 'columnSize' ? { 'file.name': 260, 'note.bogus': 'wide', 'note.tiny': 5 } : undefined),
		}, null, ['file.name', 'note.tiny']);

		check('저장된 폭을 그대로 복원한다', headerEls(containerEl)[0].style.flex === '0 0 260px');
		check('숫자가 아니거나 최소 폭 미만인 값은 버린다', headerEls(containerEl)[1].style.flex === '1 0 40px', headerEls(containerEl)[1].style.flex);
		view.unload();
	}

	console.log('\n[15] 열 헤더 우클릭 — 메뉴 없음');
	resetStubs();
	{
		// 폭 되돌리기 2항목은 **경계 더블클릭**이 대신한다(8차 4번) — 메뉴가 빌 바에는 메뉴 자체를 없앤다.
		const props = ['file.name', 'note.status'];
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], null, null, props);

		headerEls(containerEl)[0].dispatch('contextmenu');
		check('헤더 우클릭에 메뉴가 뜨지 않는다', Menu.instances.length === 0, String(Menu.instances.length));

		resizerEl(containerEl, 0).dispatch('contextmenu');
		check('손잡이 우클릭에도 메뉴가 없다', Menu.instances.length === 0);

		// 행 우클릭(열기 메뉴)은 그대로 살아 있어야 한다 — 없앤 것은 헤더 쪽뿐이다.
		rowEl(containerEl).dispatch('contextmenu');
		check('행 우클릭 메뉴는 그대로다', Menu.instances.length === 1 && Menu.instances[0].items.length === 1, String(Menu.instances.length));
		view.unload();
	}

	console.log('\n[16] 페이지 크기 — 직접 입력·구버전 호환');
	const manyEntries = Array.from({ length: 25 }, (_, i) => makeEntry('Note ' + i));
	const visibleRows = (containerEl) => visibleRowEls(containerEl).length;

	for (const [label, stored, expected] of [
		['입력칸 값(문자열)이 그대로 먹는다', { rowLimit: 'pages', pageSize: '7' }, 7],
		['1 단위 값도 먹는다', { rowLimit: 'pages', pageSize: '13' }, 13],
		['구버전 슬라이더 값(숫자)도 그대로 먹는다', { rowLimit: 'pages', pageSize: 10 }, 10],
		['비어 있으면 기본값 50', { rowLimit: 'pages', pageSize: '' }, 25],
		['공백만 있어도 기본값', { rowLimit: 'pages', pageSize: '   ' }, 25],
		['숫자가 아니면 기본값', { rowLimit: 'pages', pageSize: 'abc' }, 25],
		['0 이나 음수는 기본값', { rowLimit: 'pages', pageSize: '0' }, 25],
		['소수는 내림한다', { rowLimit: 'pages', pageSize: '4.9' }, 4],
		['값이 없으면 기본값 50', { rowLimit: 'pages' }, 25],
	]) {
		resetStubs();
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, manyEntries, { get: (k) => stored[k] });
		check(label, visibleRows(containerEl) === expected, 'rows=' + visibleRows(containerEl));
		view.unload();
	}

	console.log('\n[16-0] Row limit — 기존 .base 읽기 호환 (디자인 B1 · 확정 1)');
	// 기본이 `Show all` 로 바뀌었으므로, 예전 뷰가 **조용히 제한을 잃지 않게** 세 갈래로 받는다.
	for (const [label, stored, expected] of [
		['새 키가 있으면 그 값이 이긴다', { rowLimit: 'all', limitRows: true, pageSize: '5' }, 25],
		['limitRows:false 는 Show all 로 읽는다', { limitRows: false, pageSize: '5' }, 25],
		['limitRows:true 는 Pages 로 읽는다 (명시적으로 켠 제한을 풀지 않는다)', { limitRows: true, pageSize: '5' }, 5],
		['limitRows 없이 pageSize 만 있어도 Pages 다', { pageSize: '6' }, 6],
		['아무것도 없으면 Show all — 아무것도 안 만진 뷰가 조용히 잘리지 않는다', {}, 25],
		['빈 pageSize 는 설정이 없는 것으로 본다', { pageSize: '  ' }, 25],
		['모르는 값이면 기본값으로 떨어진다', { rowLimit: 'bogus' }, 25],
	]) {
		resetStubs();
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, manyEntries, { get: (k) => stored[k] });
		check(label, visibleRows(containerEl) === expected, 'rows=' + visibleRows(containerEl));
		view.unload();
	}

	resetStubs();
	{
		// 입력칸은 문자열만 표시하므로(코어 제약) 예전 숫자 값은 칸이 비어 보인다 — 자리표시자가 실제 적용값을 말해야
		// 화면과 동작이 어긋나지 않는다.
		const { app } = makeApp('visible');
		const { registration, view } = await mount(app, [makeEntry('Note A')]);

		const legacy = registration.options(makeConfig({ get: (k) => (k === 'pageSize' ? 30 : undefined) }));
		check('구버전 숫자 값이 자리표시자로 보인다', legacy.find((o) => o.key === 'pageSize').placeholder === '30');

		const fresh = registration.options(makeConfig());
		check('설정이 없으면 자리표시자가 기본값이다', fresh.find((o) => o.key === 'pageSize').placeholder === '50');

		// 숫자 칸은 자기 방식일 때만 보인다 — 안 쓰이는 칸을 남겨 두면 그 값이 먹는 줄로 읽힌다(G1).
		const showAll = registration.options(makeConfig());
		check('Show all 이면 두 숫자 칸을 모두 감춘다', showAll.find((o) => o.key === 'pageSize').shouldHide() === true && showAll.find((o) => o.key === 'groupSize').shouldHide() === true);

		const pages = registration.options(makeConfig({ get: (k) => (k === 'rowLimit' ? 'pages' : undefined) }));
		check('Pages 면 Rows per page 만 보인다', pages.find((o) => o.key === 'pageSize').shouldHide() === false && pages.find((o) => o.key === 'groupSize').shouldHide() === true);

		for (const mode of ['group-top', 'group-pages']) {
			const grouped = registration.options(makeConfig({ get: (k) => (k === 'rowLimit' ? mode : undefined) }));
			check(`${mode} 면 Rows per group 만 보인다`, grouped.find((o) => o.key === 'groupSize').shouldHide() === false && grouped.find((o) => o.key === 'pageSize').shouldHide() === true);
		}

		const legacyOff = registration.options(makeConfig({ get: (k) => (k === 'limitRows' ? false : undefined) }));
		check('예전 뷰의 감추기 판정도 새 규칙을 탄다', legacyOff.find((o) => o.key === 'pageSize').shouldHide() === true);
		view.unload();
	}

	console.log('\n[16-1] 페이지 크기 — 설정 기본값 연동');
	resetStubs();
	{
		const many = Array.from({ length: 25 }, (_, i) => makeEntry('Note ' + i));
		const { app } = makeApp('visible');
		// 설정 기본값 8 · 뷰 옵션은 비워 둔다.
		const { plugin, view, containerEl, registration } = await mount(app, many, { get: (k) => (k === 'rowLimit' ? 'pages' : undefined) }, { defaultPageSize: 8 });

		check('뷰가 비어 있으면 설정 기본값을 쓴다', visibleRows(containerEl) === 8, 'rows=' + visibleRows(containerEl));
		check('자리표시자도 설정 기본값을 따른다', registration.options(makeConfig()).find((o) => o.key === 'pageSize').placeholder === '8');

		// 설정을 바꾸면 이미 열려 있는 뷰가 곧바로 따라와야 한다.
		plugin.settings.defaultPageSize = 3;
		await plugin.saveSettings();
		check('설정을 바꾸면 열려 있는 뷰가 즉시 다시 그린다', visibleRows(containerEl) === 3, 'rows=' + visibleRows(containerEl));
		check('페이저도 새 기본값으로 다시 센다', viewPagerText(containerEl) === '1 / 9', String(viewPagerText(containerEl)));
		// 떨어진 뷰의 뿌리를 붙들고 있다가, 설정을 바꿔도 그쪽이 다시 그려지지 않는지 본다(구독이 진짜 풀렸는지).
		const detachedRoot = containerEl.find('bases-plus-view');
		const rowsBefore = detachedRoot.findAll('bases-plus-row').filter((el) => !el.hidden).length;
		view.unload();

		plugin.settings.defaultPageSize = 9;
		await plugin.saveSettings();
		const rowsAfter = detachedRoot.findAll('bases-plus-row').filter((el) => !el.hidden).length;
		check('unload 하면 설정 알림 구독을 푼다', rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);
		check('뷰 뿌리도 컨테이너에서 떨어진다', containerEl.find('bases-plus-view') === null);
	}

	resetStubs();
	{
		const many = Array.from({ length: 25 }, (_, i) => makeEntry('Note ' + i));
		const { app } = makeApp('visible');
		// 뷰에 값이 있으면 설정과 무관하게 그 값이 이긴다.
		const { plugin, view, containerEl } = await mount(app, many, { get: (k) => ({ rowLimit: 'pages', pageSize: '4' })[k] }, { defaultPageSize: 8 });

		check('뷰에 넣은 값이 설정보다 우선한다', visibleRows(containerEl) === 4);

		plugin.settings.defaultPageSize = 20;
		await plugin.saveSettings();
		check('설정을 바꿔도 뷰 명시값은 그대로다', visibleRows(containerEl) === 4);
		view.unload();
	}

	console.log('\n[17] 뷰 수명주기 — 실물 순서');
	resetStubs();
	{
		// 실앱은 팩토리를 부를 때 config 를 아직 안 붙인다(app.js 오프셋 2500709). 생성자가 config 를 만지면
		// 탭에서는 빈 화면, 임베드에서는 코드블록 오류 토스트가 된다 — 실기동 2차에서 실제로 그렇게 깨졌다.
		const { app } = makeApp('visible');
		const exported = require(BUNDLE);
		const PluginClass = exported.default || exported;
		const plugin = new PluginClass(app, { id: 'bases-plus' });
		await plugin.onload();

		const containerEl = new FakeEl('div', 'bases-view');
		let constructed = null;
		let threw = null;
		try {
			constructed = plugin.basesViews[0].registration.factory({ app }, containerEl);
		} catch (error) {
			threw = error;
		}
		check('config 없이 만들어도 생성자가 안 터진다', threw === null, threw && threw.message);
		check('생성만 해도 컨테이너에 뷰 뼈대가 선다', containerEl.find('bases-plus-view') !== null);

		// config 는 그다음에 붙고, 저장된 폭은 첫 갱신 때 읽혀야 한다.
		constructed.config = makeConfig({ get: (k) => (k === 'columnSize' ? { 'file.name': 210 } : undefined) });
		constructed.allProperties = DEFAULT_PROPS;
		constructed.data = { data: [makeEntry('Note A')], properties: DEFAULT_PROPS };
		constructed.onDataUpdated();
		check('저장된 폭은 첫 갱신 때 읽는다', headerEls(containerEl)[0].style.flex === '0 0 210px', headerEls(containerEl)[0].style.flex);
		check('첫 갱신에서 행이 그려진다', containerEl.findAll('bases-plus-row').length === 1);
		constructed.unload();
	}

	resetStubs();
	{
		// 렌더가 터져도 화면이 그냥 비면 원인을 못 찾는다 — 콘솔에 남기고 화면에도 한 줄 띄운다.
		const { app } = makeApp('visible');
		const errors = [];
		const originalError = console.error;
		console.error = (...args) => { errors.push(args[0]); };

		let view, containerEl;
		try {
			const mounted = await mount(app, [makeEntry('Note A')], {
				getDisplayName: () => { throw new Error('stub: getDisplayName failed'); },
			});
			view = mounted.view;
			containerEl = mounted.containerEl;
		} finally {
			console.error = originalError;
		}

		const errorEl = containerEl.find('bases-plus-error');
		check('렌더가 터져도 예외를 밖으로 던지지 않는다', view !== undefined);
		check('실패를 콘솔에 남긴다', errors.some((m) => String(m).indexOf('Bases Plus') === 0), errors.join('|'));
		check('실패를 화면에도 알린다', errorEl !== null && errorEl.hidden === false && errorEl.text.indexOf('console') !== -1);
		check('is-loading 은 실패해도 벗긴다', !containerEl.hasClass('is-loading'));
		view.unload();
	}

	console.log('\n[18] 모달 — 조건부 제목·버튼 문구');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();

		// 마크다운은 편집기 안에 인라인 제목이 있어 모달 제목을 넣으면 두 줄로 겹친다.
		check('마크다운은 모달 제목을 넣지 않는다', Modal.instances[0].contentEl.find('bases-plus-modal-title') === null && Modal.instances[0].titleEl.text === '');

		const actions = Modal.instances[0].contentEl.find('bases-plus-modal-actions');
		check('버튼에 문구가 함께 찍힌다', actions.children.map((el) => el.textContent).join('|') === 'New tab|New window', actions.children.map((el) => el.textContent).join('|'));
		// 코어의 "Open in new tab"·"Open in new window" 메뉴 항목과 같은 글리프다 — 코어는 `lucide-` 접두사를 붙여
		// 부르지만 `setIcon` 이 접두사 없는 이름도 같은 아이콘으로 푼다(app.js `Sg`).
		check('아이콘은 코어 메뉴와 같은 것을 쓴다', actions.children.map((el) => el.children[0].iconName).join('|') === 'file-plus|picture-in-picture-2');
		check('툴팁·aria 는 전체 문구를 유지한다', actions.children[0].tooltip === 'Open in new tab' && actions.children[0].attrs['aria-label'] === 'Open in new tab');
		Modal.instances[0].close();
		view.unload();
	}

	resetStubs();
	{
		// `.base` 처럼 인라인 제목이 없는 대상은 무엇을 열었는지 알 수 없다 — 그때는 제목을 넣는다.
		const { app } = makeApp('visible');
		const entry = makeEntry('Demo');
		entry.file.extension = 'base';
		entry.file.name = 'Demo.base';

		const { view, containerEl } = await mount(app, [entry]);
		clickName(containerEl);
		await wait();
		check('.base 처럼 인라인 제목이 없는 대상은 제목을 넣는다', Modal.instances[0].contentEl.find('bases-plus-modal-title').text === 'Demo');
		check('코어 제목 칸은 쓰지 않는다 (한 줄 헤더 규칙)', Modal.instances[0].titleEl.text === '');
		check('제목이 없어도 접근성 이름은 남긴다', Modal.instances[0].modalEl.attrs['aria-label'] === 'Demo');
		Modal.instances[0].close();
		view.unload();
	}

	resetStubs();
	{
		// 사용자가 "문서 내 제목 표시"를 끄면 마크다운도 인라인 제목이 없다 — 그때는 마크다운도 제목이 필요하다.
		const { app } = makeApp('visible', { showInlineTitle: false });
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		clickName(containerEl);
		await wait();
		check('인라인 제목을 꺼 뒀으면 마크다운도 제목을 넣는다', Modal.instances[0].contentEl.find('bases-plus-modal-title').text === 'Note A');
		Modal.instances[0].close();
		view.unload();
	}

	resetStubs();
	{
		// 이번 통일 규칙의 핵심 — 두 모달의 형태가 같고 다른 것은 제목 유무뿐이다.
		const shapeOf = async (file) => {
			resetStubs();
			const { app } = makeApp('visible');
			const entry = makeEntry('Note A');
			if (file) Object.assign(entry.file, file);
			const mounted = await mount(app, [entry]);
			clickName(mounted.containerEl);
			await wait();
			const headerEl = Modal.instances[0].contentEl.find('bases-plus-modal-header');
			const shape = {
				hasHeader: headerEl !== null,
				children: headerEl.children.map((el) => Array.from(el.classes).join(' ')),
				headerIsFirst: Modal.instances[0].contentEl.children[0] === headerEl,
			};
			Modal.instances[0].close();
			mounted.view.unload();
			return shape;
		};

		const markdown = await shapeOf(null);
		const base = await shapeOf({ extension: 'base', name: 'Demo.base' });

		check('두 경우 모두 헤더 행을 만든다', markdown.hasHeader && base.hasHeader);
		check('헤더가 본문 맨 앞에 온다', markdown.headerIsFirst && base.headerIsFirst);
		check('마크다운 헤더는 액션만 갖는다', markdown.children.join('|') === 'bases-plus-modal-actions', markdown.children.join('|'));
		check('.base 헤더는 제목 + 액션이다', base.children.join('|') === 'bases-plus-modal-title|bases-plus-modal-actions', base.children.join('|'));
		check('두 헤더의 차이는 제목 유무뿐이다', base.children.filter((c) => c !== 'bases-plus-modal-title').join('|') === markdown.children.join('|'));
	}

	console.log('\n[19] 그룹 분할');
	resetStubs();
	{
		const props = ['file.name', 'note.status'];
		const a = makeEntry('A', { 'note.status': textValue('진행중') });
		const b = makeEntry('B', { 'note.status': textValue('진행중') });
		const c = makeEntry('C', { 'note.status': textValue('완료') });
		const d = makeEntry('D');
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [a, b, c, d], null, null, props);

		check('그룹이 없으면 헤딩을 그리지 않는다', containerEl.findAll('bases-plus-group-heading').length === 0);

		view.data = {
			data: [a, b, c, d],
			properties: props,
			groupedData: [
				{ key: textValue('진행중'), hasKey: () => true, entries: [a, b] },
				{ key: textValue('완료'), hasKey: () => true, entries: [c] },
				{ key: textValue(''), hasKey: () => false, entries: [d] },
			],
		};
		view.onDataUpdated();

		const headings = headingEls(containerEl);
		const headingValue = (el) => el.find('bases-plus-group-value').textContent;
		check('그룹 수만큼 헤딩이 생긴다', headings.length === 3, 'headings=' + headings.length);
		check('헤딩에 그룹 값이 그려진다', headings.slice(0, 2).map(headingValue).join('|') === '진행중|완료');
		// 네이티브 문구는 `labelGroupKeyNone` = `None` 이다. 우리가 쓰던 `No value` 는 네이티브에 없는 말이었다.
		check('값이 없는 묶음은 네이티브와 같은 None 이다', headingValue(headings[2]) === 'None', headingValue(headings[2]));
		// 첫 그룹만 표시가 다르다(위 선 제거). 재사용 풀 때문에 :first-child 로는 못 잡는다.
		check('첫 그룹에만 is-first-group 이 붙는다', headings[0].hasClass('is-first-group') && !headings[1].hasClass('is-first-group'));
		check('그룹 기준을 못 읽으면 속성명 자리를 감춘다', headings[0].find('bases-plus-group-property').hidden === true);
		check('행은 그대로 4개다', containerEl.findAll('bases-plus-row').filter((el) => !el.hidden).length === 4);

		// 헤딩과 행이 그룹 순서대로 섞여 있어야 한다.
		const layoutOf = (containerEl) => containerEl.find('bases-plus-rows').children
			.filter((el) => !el.hidden && !el.hasClass('bases-plus-drop-indicator'))
			.map((el) =>
				el.hasClass('bases-plus-group-heading')
					? 'H:' + el.find('bases-plus-group-value').textContent
					: el.hasClass('bases-plus-group-footer')
						? 'F'
						: 'R:' + textOf(el.children[0].children[0])
			);
		check('헤딩 뒤에 그 그룹의 행이 온다', layoutOf(containerEl).join(' ') === 'H:진행중 R:A R:B H:완료 R:C H:None R:D', layoutOf(containerEl).join(' '));
		check('그룹 개수를 헤딩에 늘 표시한다', headings.map((el) => el.find('bases-plus-group-count').text).join('|') === '2|1|1', headings.map((el) => el.find('bases-plus-group-count').text).join('|'));

		// 페이징이 걸리면 네이티브처럼 "정렬된 전체에서 앞 N개"만 남고, 그 행이 속한 그룹만 남는다.
		view.data = {
			data: [a, b, c, d],
			properties: props,
			groupedData: [
				{ key: textValue('진행중'), hasKey: () => true, entries: [a, b] },
				{ key: textValue('완료'), hasKey: () => true, entries: [c] },
			],
		};
		view.config.stored.pageSize = '2';
		view.onDataUpdated();
		check('페이징이 걸리면 남은 행이 있는 그룹만 그린다', layoutOf(containerEl).join(' ') === 'H:진행중 R:A R:B', layoutOf(containerEl).join(' '));
		// 전체 4행을 2씩 끊는다 — 그룹으로 나누기 **전에** 자르는 네이티브 순서를 페이저 수가 증언한다(B4).
		check('페이지 수는 전체 기준으로 센다', viewPagerText(containerEl) === '1 / 2', String(viewPagerText(containerEl)));

		view.config.stored.pageSize = '';
		view.data = { data: [a, b, c, d], properties: props };
		view.onDataUpdated();
		check('그룹이 사라지면 헤딩을 감춘다', headingEls(containerEl).length === 0);
		view.unload();
	}

	resetStubs();
	{
		// 그룹 기준 속성명을 네이티브처럼 값 앞에 붙인다(비공개 필드 읽기 1지점).
		const props = ['file.name', 'note.status'];
		const a = makeEntry('A', { 'note.status': textValue('진행중') });
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [a], null, null, props);

		view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		view.data = {
			data: [a],
			properties: props,
			groupedData: [{ key: textValue('진행중'), hasKey: () => true, entries: [a] }],
		};
		view.onDataUpdated();

		const heading = containerEl.find('bases-plus-group-heading');
		check('그룹 기준 속성명을 값 앞에 붙인다', heading.find('bases-plus-group-property').text === 'status', heading.find('bases-plus-group-property').text);
		check('속성명 자리가 보인다', heading.find('bases-plus-group-property').hidden === false);
		// 자식이 늘었다(접기 화살표·개수·손잡이) — 자리는 인덱스로 확인한다.
		const partAt = (cls) => heading.children.findIndex((el) => el.hasClass(cls));
		check('속성명이 값보다 앞에 온다', partAt('bases-plus-group-property') < partAt('bases-plus-group-value'));
		check('접기 화살표가 맨 앞이다', partAt('bases-plus-group-toggle') === 0);
		check('개수는 값 뒤에 온다', partAt('bases-plus-group-count') > partAt('bases-plus-group-value'));
		// 손잡이는 절대 배치라 어디 둬도 같은 자리에 그려진다 — 행과 같은 순서(맨 뒤)로 통일한다(C2 함정).
		check('손잡이는 맨 뒤다 (행과 같은 순서)', partAt('bases-plus-order-handle') === heading.children.length - 1);

		// 옵시디언이 groupBy 를 바꾸거나 없애면 속성명만 사라지고 값은 그대로여야 한다.
		delete view.config.groupBy;
		view.onDataUpdated();
		check('그룹 기준을 못 읽어도 값은 그대로 그린다', heading.find('bases-plus-group-property').hidden === true && heading.find('bases-plus-group-value').textContent === '진행중');
		view.unload();
	}

	console.log('\n[20] 셀 인라인 편집');
	resetStubs();
	{
		const props = ['file.name', 'note.status', 'note.priority', 'formula.calc'];
		const entry = makeEntry('Note A', {
			'note.status': textValue('진행중'),
			'note.priority': numberValue(2),
			'formula.calc': textValue('계산값'),
		});
		const { app, frontmatter } = makeApp('visible');
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));

		check('프론트매터 열만 편집 대상 표시가 붙는다', cells.map((el) => el.hasClass('is-editable')).join(',') === 'false,true,true,false');

		// 텍스트 값 편집
		cells[1].dispatch('click', { target: plainTarget });
		const input = cells[1].find('bases-plus-cell-input');
		// 텍스트는 여러 줄이 되어야 해서 textarea 다(7차 3번) — type 속성이 없는 대신 태그가 다르다.
		check('클릭하면 입력칸이 뜬다', input !== null && input.tag === 'textarea', input && input.tag);
		check('현재 값이 입력칸 초기값이다', input.value === '진행중');
		check('입력칸에 포커스를 준다', input.focused === true);

		input.value = '완료';
		input.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('Enter 면 프론트매터에 저장한다', frontmatter['notes/Note A.md'].status === '완료', JSON.stringify(frontmatter));

		// 숫자 값은 숫자로 저장한다
		cells[2].dispatch('click', { target: plainTarget });
		const numberInput = cells[2].find('bases-plus-cell-input');
		check('숫자 열은 숫자 입력칸이다', numberInput.attrs.type === 'number');
		numberInput.value = '5';
		numberInput.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('숫자로 저장한다 (문자열 아님)', frontmatter['notes/Note A.md'].priority === 5);

		// Escape 는 저장하지 않는다
		cells[1].dispatch('click', { target: plainTarget });
		const cancelled = cells[1].find('bases-plus-cell-input');
		cancelled.value = '버림';
		cancelled.dispatch('keydown', { key: 'Escape' });
		await wait();
		check('Escape 면 저장하지 않는다', frontmatter['notes/Note A.md'].status === '완료');
		check('Escape 뒤에는 입력칸이 사라진다', cells[1].find('bases-plus-cell-input') === null);

		// 비우면 속성을 지운다
		cells[1].dispatch('click', { target: plainTarget });
		const cleared = cells[1].find('bases-plus-cell-input');
		cleared.value = '   ';
		cleared.dispatch('blur');
		await wait();
		check('비우고 나가면 속성을 지운다', !('status' in frontmatter['notes/Note A.md']));

		// 수식·파일 열은 편집하지 않는다
		cells[3].dispatch('click', { target: plainTarget });
		check('수식 열은 편집칸이 안 뜬다', cells[3].find('bases-plus-cell-input') === null);
		cells[0].dispatch('click', { target: plainTarget });
		check('파일 이름 열도 편집칸이 안 뜬다', cells[0].find('bases-plus-cell-input') === null);
		view.unload();
	}

	resetStubs();
	{
		// 편집 중에 데이터 갱신이 와도 입력칸이 사라지면 안 된다.
		const props = ['file.name', 'note.status'];
		const entry = makeEntry('Note A', { 'note.status': textValue('진행중') });
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];

		cell.dispatch('click', { target: plainTarget });
		cell.find('bases-plus-cell-input').value = '입력 중';
		view.data = { data: [entry], properties: props };
		view.onDataUpdated();

		const stillThere = cell.find('bases-plus-cell-input');
		check('갱신이 와도 편집 중인 칸은 유지된다', stillThere !== null && stillThere.value === '입력 중');
		check('편집 중 표시가 붙는다', cell.hasClass('is-editing'));
		view.unload();
	}

	console.log('\n[21] 인라인 편집 — 기본 뷰 패리티');
	resetStubs();
	{
		// 빈 값은 NullValue 로 온다 — toString() 이 문자열 "null" 이고 타입도 'null' 이다.
		// 이것을 편집 불가로 걸러 내던 것이 "빈 칸은 수정이 안 된다" 의 원인이었다.
		const props = ['file.name', 'note.status', 'note.due', 'note.tags'];
		const entry = makeEntry('Note A', {
			'note.status': nullValue(),
			'note.due': dateValue('2026-08-10'),
			'note.tags': listValue(['a', 'b']),
		});
		const { app, frontmatter } = makeApp('visible');
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));

		check('빈 값 칸도 편집 대상이다', cells[1].hasClass('is-editable'));
		cells[1].dispatch('click', { target: plainTarget });
		const empty = cells[1].find('bases-plus-cell-input');
		check('빈 값 칸을 누르면 입력칸이 뜬다', empty !== null);
		check('빈 값이 "null" 글자로 채워지지 않는다', empty.value === '', JSON.stringify(empty.value));
		empty.value = '진행중';
		empty.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('빈 칸에 새 값을 넣을 수 있다', frontmatter['notes/Note A.md'].status === '진행중');

		// 날짜 — 화면 텍스트가 아니라 값에서 읽어야 기존 값이 살아 있다.
		cells[2].dispatch('click', { target: plainTarget });
		const due = cells[2].find('bases-plus-cell-input');
		check('날짜 칸은 날짜 입력이다', due.attrs.type === 'date');
		check('날짜의 기존 값이 지워지지 않는다', due.value === '2026-08-10', JSON.stringify(due.value));
		check('날짜는 달력을 바로 띄운다', due.pickerShown === true);
		due.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('그대로 저장하면 값이 유지된다', frontmatter['notes/Note A.md'].due === '2026-08-10');

		// 목록(태그·별칭 등) — 7차부터 **클릭 없이** 알약이 떠 있고 입력칸도 상시다. 저장 형태는 배열 그대로다.
		const tags = cells[3].find('bases-plus-chip-input');
		check('목록 값은 클릭 없이도 알약으로 보인다', pillTexts(cells[3]).join('|') === 'a|b', pillTexts(cells[3]).join('|'));
		check('추가 입력칸이 상시로 있다', tags !== null);
		tags.value = 'c';
		tags.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('목록은 배열로 저장한다', Array.isArray(frontmatter['notes/Note A.md'].tags) && frontmatter['notes/Note A.md'].tags.join('|') === 'a|b|c');

		// 강조 테두리는 입력칸이 아니라 셀이 갖는다(네이티브 `.bases-td:focus-within` 과 같은 자리).
		cells[1].dispatch('click', { target: plainTarget });
		check('편집 중에는 셀에 강조 표시가 붙는다', cells[1].hasClass('is-editing'));
		cells[1].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });
		await wait();
		check('편집이 끝나면 강조 표시를 뗀다', cells[1].hasClass('is-editing') === false);
		view.unload();
	}

	resetStubs();
	{
		// 링크 값은 화면 글자(별칭)와 저장 원문이 다르다 — 원문을 고쳐야 링크가 깨지지 않는다.
		const props = ['file.name', 'note.ref', 'note.when'];
		const entry = makeEntry('Note A', {
			'note.ref': linkValue('[[Note B|별칭]]', '별칭'),
			'note.when': dateValue('2026-08-10T09:30'),
		});
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));

		cells[1].dispatch('click', { target: plainTarget });
		const ref = cells[1].find('bases-plus-cell-input');
		check('링크는 저장 원문을 보여 준다 (별칭 아님)', ref.value === '[[Note B|별칭]]', JSON.stringify(ref.value));

		cells[2].dispatch('click', { target: plainTarget });
		const when = cells[2].find('bases-plus-cell-input');
		check('시각이 있는 값은 datetime 입력이다', when.attrs.type === 'datetime-local', when.attrs.type);
		check('시각까지 그대로 들어온다', when.value === '2026-08-10T09:30');
		view.unload();
	}

	console.log('\n[23] 실기동 6차 피드백 — 유형 아이콘·목록 편집·빈 날짜·정렬·폭 리셋');
	resetStubs();
	{
		// 1. 열 헤더 속성 유형 아이콘 — 네이티브 헤더와 같은 갈래(note=위젯 아이콘 · formula·file=고정).
		const props = ['file.name', 'note.due', 'note.tags', 'note.priority', 'note.무엇', 'formula.calc'];
		const { app } = makeApp('visible', null, {
			due: 'date',
			tags: 'tags',
			priority: 'number',
			무엇: 'bogus-widget',
		});
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], null, null, props);

		check(
			'헤더에 속성 유형 아이콘이 붙는다',
			headerIcons(containerEl).join('|') ===
				'lucide-info|lucide-calendar|lucide-tags|lucide-binary|lucide-file-question|lucide-square-function',
			headerIcons(containerEl).join('|')
		);
		check('아이콘이 붙어도 헤더 문구는 그대로다', headerTexts(containerEl).join('|') === 'name|due|tags|priority|무엇|calc', headerTexts(containerEl).join('|'));
		check('아이콘과 이름은 라벨 안 별개 조각이다', headerEls(containerEl)[0].find('bases-plus-th-label').children.length === 2);

		// 다시 그려도 조각이 늘지 않아야 한다 — 갱신마다 아이콘을 새로 붙이면 svg 가 쌓인다(성2).
		view.onDataUpdated();
		check('다시 그려도 라벨 조각이 늘지 않는다', headerEls(containerEl)[0].find('bases-plus-th-label').children.length === 2);
		view.unload();
	}

	resetStubs();
	{
		// 3(7차 1번). 목록·태그는 **클릭 없이** 알약으로 보이고, x 로 즉시 지우고, 바로 추가한다.
		const props = ['file.name', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.tags': listValue(['설계', 'Hello, world']) });
		const { app, frontmatter } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];

		check('클릭 전부터 알약으로 보인다', pillTexts(cell).join('|') === '설계|Hello, world', pillTexts(cell).join('|'));
		check('한 줄 텍스트 입력이 아니다', cell.find('bases-plus-cell-input') === null);
		check('코어 알약 어휘를 쓴다', cell.find('multi-select-container') !== null);
		check('항목 안 쉼표가 살아 있다 (toString 을 쪼개지 않는다)', pillTexts(cell)[1] === 'Hello, world');

		// 추가 — 모드 전환 없이 상시 입력칸에 치고 Enter.
		const input = cell.find('bases-plus-chip-input');
		check('추가 입력칸이 상시로 떠 있다', input !== null);
		input.value = '검수';
		input.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('Enter 로 항목이 알약으로 들어간다', pillTexts(cell).join('|') === '설계|Hello, world|검수', pillTexts(cell).join('|'));
		check('항목을 넣으면 입력칸이 비워진다', input.value === '');
		check('추가는 바로 저장된다 (모드 전환 없음)', frontmatter['notes/Note A.md'].tags.join('|') === '설계|Hello, world|검수', JSON.stringify(frontmatter));

		// 제거 — x 를 누르면 그 자리에서 지워지고 바로 저장된다.
		cell.findAll('multi-select-pill')[1].find('multi-select-pill-remove-button').dispatch('click');
		await wait();
		check('x 가 그 항목만 뺀다', pillTexts(cell).join('|') === '설계|검수', pillTexts(cell).join('|'));
		check('제거도 바로 저장된다', frontmatter['notes/Note A.md'].tags.join('|') === '설계|검수');
		check('알약 셀은 편집 모드로 들어가지 않는다', cell.hasClass('is-editing') === false);

		// 조합 중 Enter 는 항목을 넣지 않는다(6차 가드 유지).
		input.value = '한글';
		input.dispatch('keydown', { key: 'Enter', isComposing: true });
		check('조합 중 Enter 는 항목을 안 넣는다', pillTexts(cell).join('|') === '설계|검수');
		view.unload();
	}

	resetStubs();
	{
		const props = ['file.name', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.tags': listValue(['a']) });
		const { app, frontmatter } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];
		const input = cell.find('bases-plus-chip-input');

		// 치다 만 글자도 버리지 않는다 — 셀을 떠나는 순간 항목으로 굳는다.
		input.value = '남은 글자';
		input.dispatch('blur');
		await wait();
		check('입력칸에 남은 글자도 항목으로 저장한다', frontmatter['notes/Note A.md'].tags.join('|') === 'a|남은 글자', JSON.stringify(frontmatter));

		// 빈 입력칸 Backspace 로 마지막 항목을 뺀다 — 전부 빠지면 속성 자체를 지운다.
		const live = cell.find('bases-plus-chip-input');
		live.dispatch('keydown', { key: 'Backspace' });
		live.dispatch('keydown', { key: 'Backspace' });
		await wait();
		check('빈 입력칸의 Backspace 가 마지막 항목을 뺀다', pillTexts(cell).length === 0, String(pillTexts(cell).length));
		check('항목이 하나도 없으면 속성을 지운다', !('tags' in frontmatter['notes/Note A.md']), JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		// 값이 비어 있어도 등록 유형이 목록이면 알약 칸이다 — 빈 태그 칸에도 바로 추가할 수 있어야 한다.
		const props = ['file.name', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.tags': nullValue() });
		const { app, frontmatter } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];

		check('빈 목록 칸도 알약 칸이다', cell.find('multi-select-container') !== null);
		check('빈 목록 칸에는 알약이 없다', pillTexts(cell).length === 0);
		const input = cell.find('bases-plus-chip-input');
		input.value = '새 항목';
		input.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('빈 칸에 바로 항목을 넣을 수 있다', frontmatter['notes/Note A.md'].tags.join('|') === '새 항목', JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		// 항목을 못 세는 목록은 toString() 을 쉼표로 나눠 떨어진다.
		const props = ['file.name', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.tags': opaqueListValue('a, b') });
		const { app } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];

		check('항목을 못 세면 쉼표로 나눠 떨어진다', pillTexts(cell).join('|') === 'a|b', pillTexts(cell).join('|'));
		view.unload();
	}

	resetStubs();
	{
		// 3(버그). 조합(IME) 중의 Enter 는 한글을 확정하는 키다 — 가로채면 방금 친 글자가 사라진다.
		const props = ['file.name', 'note.status', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.status': textValue('진행'), 'note.tags': listValue(['a']) });
		const { app, frontmatter } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));

		cells[1].dispatch('click', { target: plainTarget });
		const input = cells[1].find('bases-plus-cell-input');
		input.value = '진행중';
		input.dispatch('keydown', { key: 'Enter', isComposing: true });
		await wait();
		check('조합 중 Enter 는 저장하지 않는다', frontmatter['notes/Note A.md'] === undefined);
		check('조합 중 Enter 뒤에도 편집이 살아 있다', cells[1].find('bases-plus-cell-input') !== null);

		// 조합이 끝난 뒤의 Enter 가 진짜 저장이다.
		input.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('조합이 끝난 Enter 는 저장한다', frontmatter['notes/Note A.md'].status === '진행중');

		cells[2].dispatch('click', { target: plainTarget });
		const listInput = cells[2].find('bases-plus-cell-multi-input');
		listInput.value = '검수';
		listInput.dispatch('keydown', { key: 'Enter', isComposing: true });
		check('조합 중 Enter 는 항목을 넣지 않는다', pillTexts(cells[2]).join('|') === 'a', pillTexts(cells[2]).join('|'));
		listInput.dispatch('keydown', { key: 'Enter' });
		check('조합이 끝난 Enter 는 항목을 넣는다', pillTexts(cells[2]).join('|') === 'a|검수');
		view.unload();
	}

	resetStubs();
	{
		// 4. 빈 값 칸은 등록된 속성 유형을 따라간다. 빈 값은 NullValue 라 타입이 문자열 'null' 로 온다 —
		// 이것을 빈 값으로 안 보면 전부 텍스트 입력으로 떨어졌다(마스터 6차 4번).
		const props = ['file.name', 'note.due', 'note.when', 'note.count', 'note.그냥', 'note.목록'];
		const entry = makeEntry('Note A', {
			'note.due': nullValue(),
			'note.when': nullValue(),
			'note.count': nullValue(),
			'note.그냥': nullValue(),
			'note.목록': nullValue(),
		});
		const { app } = makeApp('visible', null, {
			due: 'date',
			when: 'datetime',
			count: 'number',
			목록: 'multitext',
		});
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));
		const typeOf = (cell) => (cell.find('bases-plus-cell-input') || {}).attrs?.type ?? null;

		check('빈 값 셀의 값 타입은 문자열 null 이다', cells[1].attrs['data-value-type'] === 'null', cells[1].attrs['data-value-type']);

		cells[1].dispatch('click', { target: plainTarget });
		check('빈 날짜 칸은 날짜 입력이다 (텍스트 아님)', typeOf(cells[1]) === 'date', typeOf(cells[1]));
		check('빈 날짜 칸도 달력을 바로 띄운다', cells[1].find('bases-plus-cell-input').pickerShown === true);
		cells[1].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });

		cells[2].dispatch('click', { target: plainTarget });
		check('빈 날짜+시각 칸은 datetime 입력이다', typeOf(cells[2]) === 'datetime-local', typeOf(cells[2]));
		cells[2].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });

		cells[3].dispatch('click', { target: plainTarget });
		check('빈 숫자 칸은 숫자 입력이다', typeOf(cells[3]) === 'number', typeOf(cells[3]));
		cells[3].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });

		cells[4].dispatch('click', { target: plainTarget });
		// 텍스트는 textarea 라 type 속성이 없다(7차 3번) — 태그로 확인한다.
		check('등록 유형이 없으면 텍스트 입력이다', cells[4].find('bases-plus-cell-input').tag === 'textarea', cells[4].find('bases-plus-cell-input').tag);
		cells[4].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });

		cells[5].dispatch('click', { target: plainTarget });
		check('빈 목록 칸은 알약 편집기다', cells[5].find('multi-select-container') !== null);
		check('빈 목록 칸에는 알약이 없다', pillTexts(cells[5]).length === 0);
		view.unload();
	}

	{
		// 5·6. 입력칸 리셋은 **명시도 싸움**이라 DOM 으로는 안 잡힌다 — 코어 `input[type='text']`(0,1,1)를
		// 못 이기면 선언이 통째로 죽어 셀 안에 둥근 입력칸이 겹쳐 보인다. 규칙 모양을 직접 읽어 지킨다.
		// (프리뷰 실측: 고치기 전 border-radius 8px → 고친 뒤 0px · 숫자 정렬 start → right)
		const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const hasRule = (selector) => css.indexOf(selector) !== -1;

		check('입력칸 리셋이 한 단짜리 클래스가 아니다', hasRule('.bases-plus-cell .bases-plus-cell-input {'));
		check('입력칸 포커스 링 제거도 두 단이다', hasRule('.bases-plus-cell .bases-plus-cell-input:focus'));
		check('숫자 입력은 편집 중에도 우측 정렬이다', hasRule('.bases-plus-cell .bases-plus-cell-input[type="number"]'));
		check('목록 입력칸 리셋도 두 단이다', hasRule('.bases-plus-cell .bases-plus-cell-multi-input {'));
		check('한 단짜리 옛 리셋은 남아 있지 않다', !/\n\.bases-plus-cell-input[\s,{:]/.test(css));
	}

	resetStubs();
	{
		// 7(8차 4번). 열 경계 더블클릭 = **columnSize 에서 그 열 키를 지운다**. 잰 값을 설정으로 다시 박지 않는다
		// (네이티브 saveColumnSizes 도 customWidth 가 0 이면 키를 안 쓴다 — app.js 오프셋 3139304).
		const props = ['file.name', 'note.status', 'note.priority'];
		const { app } = makeApp('visible');
		const { view, containerEl, config } = await mount(app, [makeEntry('Note A')], null, null, props);
		const headers = headerEls(containerEl);
		headers.forEach((el, i) => { el.offsetWidth = [200, 100, 100][i]; });

		// 레이아웃이 없는 하네스라 "잘린 내용 폭"을 직접 넣어 준다 — 실제로는 scrollWidth 가 그 값이다.
		headers[1].find('bases-plus-th-label').scrollWidth = 150;

		// 먼저 한 열을 실제로 끌어 폭을 만든다.
		const handle = resizerEl(containerEl, 1);
		handle.dispatch('pointerdown', { pointerId: 3, clientX: 300 });
		handle.dispatch('pointermove', { pointerId: 3, clientX: 360 });
		handle.dispatch('pointerup', { pointerId: 3 });
		check('끌어서 만든 폭이 저장된다', config.stored.columnSize['note.status'] === 160, JSON.stringify(config.stored.columnSize));

		const dbl = handle.dispatch('dblclick', { button: 0 });
		check('더블클릭이 그 열 키를 설정에서 지운다', config.stored.columnSize['note.status'] === undefined, JSON.stringify(config.stored.columnSize));
		check('잰 값을 설정으로 다시 박지 않는다', JSON.stringify(config.stored.columnSize).indexOf('note.status') === -1);
		check('지운 열은 내용 맞춤 폭으로 선다', headerEls(containerEl)[1].style.flex === '1 0 150px', headerEls(containerEl)[1].style.flex);
		check('옆 열의 설정은 건드리지 않는다', config.stored.columnSize['file.name'] === 200);
		check('기본 동작·전파를 막는다 (헤더 메뉴로 새지 않게)', dbl.defaultPrevented === true && dbl.propagationStopped === true);

		// 내용이 아주 좁거나 아주 넓어도 네이티브와 같은 상·하한 안에 든다.
		headers[1].find('bases-plus-th-label').scrollWidth = 5;
		view.onDataUpdated();
		check('하한(40px) 아래로는 안 줄어든다', headerEls(containerEl)[1].style.flex === '1 0 40px', headerEls(containerEl)[1].style.flex);

		headers[1].find('bases-plus-th-label').scrollWidth = 4000;
		view.onDataUpdated();
		check('상한(300px) 위로는 안 늘어난다', headerEls(containerEl)[1].style.flex === '1 0 300px', headerEls(containerEl)[1].style.flex);

		// 보조 버튼 더블클릭은 무시한다 — 네이티브도 주 버튼만 본다.
		resizerEl(containerEl, 0).dispatch('dblclick', { button: 2 });
		check('보조 버튼 더블클릭은 무시한다', config.stored.columnSize['file.name'] === 200, JSON.stringify(config.stored.columnSize));
		view.unload();
	}

	resetStubs();
	{
		// 더블클릭은 pointerdown·up 을 두 번 태운다 — 안 끌고 놓았을 때 폭 굳히기가 저장되면
		// 되돌리려던 순간에 오히려 폭이 `.base` 에 박힌다.
		const props = ['file.name', 'note.status'];
		const { app } = makeApp('visible');
		const { view, containerEl, config } = await mount(app, [makeEntry('Note A')], null, null, props);
		headerEls(containerEl).forEach((el, i) => { el.offsetWidth = [200, 100][i]; });

		const handle = resizerEl(containerEl, 0);
		handle.dispatch('pointerdown', { pointerId: 5, clientX: 200 });
		check('누르는 동안에는 폭이 굳는다', headerEls(containerEl)[0].style.flex === '0 0 200px');

		handle.dispatch('pointerup', { pointerId: 5 });
		// 굳히기를 되돌리면 설정이 없는 상태로 가고, 그 상태의 화면 폭은 내용 맞춤이다(8차 4번).
		check('안 끌고 놓으면 굳히기를 되돌린다', headerEls(containerEl)[0].style.flex === '1 0 40px', headerEls(containerEl)[0].style.flex);
		check('안 끌고 놓으면 저장하지 않는다', config.stored.columnSize === undefined, JSON.stringify(config.stored));
		view.unload();
	}

	console.log('\n[24] 실기동 7차 피드백 — 텍스트 줄내림·호버 라인·속성 설정 항목');
	resetStubs();
	{
		// 3. 텍스트는 여러 줄이 된다 — Shift+Enter 는 줄바꿈, 그냥 Enter 는 저장(코어 속성 편집기와 같은 규칙).
		const props = ['file.name', 'note.memo'];
		const entry = makeEntry('Note A', { 'note.memo': textValue('첫 줄') });
		const { app, frontmatter } = makeApp('visible', null, { memo: 'text' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];

		cell.dispatch('click', { target: plainTarget });
		const editor = cell.find('bases-plus-cell-input');
		check('텍스트 편집기는 여러 줄 요소다', editor.tag === 'textarea', editor.tag);
		check('여러 줄 표시용 클래스가 붙는다', editor.hasClass('bases-plus-cell-textarea'));

		// Shift+Enter 는 우리가 가로채지 않는다 — 브라우저 기본 동작(줄바꿈)이 그대로 살아야 한다.
		const shift = editor.dispatch('keydown', { key: 'Enter', shiftKey: true });
		check('Shift+Enter 는 기본 동작을 막지 않는다', shift.defaultPrevented === false);
		check('Shift+Enter 로는 편집이 끝나지 않는다', cell.find('bases-plus-cell-input') !== null);
		check('Shift+Enter 로는 저장하지 않는다', frontmatter['notes/Note A.md'] === undefined);

		// 줄바꿈이 든 값을 그냥 Enter 로 저장한다.
		editor.value = '첫 줄\n둘째 줄';
		editor.dispatch('keydown', { key: 'Enter' });
		await wait();
		check('그냥 Enter 는 저장한다', frontmatter['notes/Note A.md'].memo === '첫 줄\n둘째 줄', JSON.stringify(frontmatter));
		check('저장 뒤 편집기가 사라진다', cell.find('bases-plus-cell-input') === null);
		view.unload();
	}

	resetStubs();
	{
		// 숫자·날짜는 줄바꿈이 값으로 성립하지 않는다 — 한 줄 입력 그대로다.
		const props = ['file.name', 'note.priority', 'note.due'];
		const entry = makeEntry('Note A', { 'note.priority': numberValue(3), 'note.due': dateValue('2026-08-10') });
		const { app } = makeApp('visible', null, { priority: 'number', due: 'date' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));

		cells[1].dispatch('click', { target: plainTarget });
		check('숫자는 한 줄 입력 그대로다', cells[1].find('bases-plus-cell-input').tag === 'input');
		cells[1].find('bases-plus-cell-input').dispatch('keydown', { key: 'Escape' });

		cells[2].dispatch('click', { target: plainTarget });
		check('날짜도 한 줄 입력 그대로다', cells[2].find('bases-plus-cell-input').tag === 'input');
		view.unload();
	}

	resetStubs();
	{
		// 5(8차). "Open property settings" 는 없어야 한다(D5-ⓑ 롤백). 10차에서 헤더 메뉴 자체가 사라져
		// 이제는 메뉴가 아예 안 뜨는 것으로 확인한다.
		const props = ['file.name', 'note.status'];
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], null, null, props);

		headerEls(containerEl)[1].dispatch('contextmenu');
		check('헤더 메뉴가 아예 없다 (속성 설정 항목 포함)', Menu.instances.length === 0, String(Menu.instances.length));
		view.unload();
	}

	resetStubs();
	{
		// 2(8차). 빈 날짜 칸은 표시 상태에서도 네이티브처럼 흐린 플레이스홀더를 세운다.
		// 값이 없어 아무것도 안 그려지던 것이 6차 "뜨지 않음" 의 실체였다(마스터 캡처 203219).
		const props = ['file.name', 'note.due', 'note.when', 'note.status', 'note.count'];
		const entry = makeEntry('Note A', {
			'note.due': nullValue(),
			'note.when': nullValue(),
			'note.status': nullValue(),
			'note.count': nullValue(),
		});
		const { app } = makeApp('visible', null, { due: 'date', when: 'datetime', count: 'number' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));
		const placeholder = (cell) => cell.find('bases-plus-empty-date');

		check('빈 날짜 칸에 플레이스홀더가 선다', placeholder(cells[1]) !== null);
		check('네이티브와 같은 클래스를 쓴다', placeholder(cells[1]).hasClass('metadata-input') && placeholder(cells[1]).hasClass('mod-date'));
		check('비어 있음 표시를 붙인다', placeholder(cells[1]).hasClass('is-empty'));
		check('표시 전용이라 비활성이다', placeholder(cells[1]).attrs.disabled === true);
		check('보조기술에 중복으로 읽히지 않는다', placeholder(cells[1]).attrs['aria-hidden'] === 'true');
		check('빈 datetime 은 시각 입력 모양이다', placeholder(cells[2]).attrs.type === 'datetime-local', placeholder(cells[2]).attrs.type);
		check('날짜가 아닌 빈 칸에는 세우지 않는다', placeholder(cells[3]) === null && placeholder(cells[4]) === null);

		// 값이 있는 날짜 칸은 값 렌더가 그린다 — 플레이스홀더를 겹쳐 세우면 두 개가 된다.
		view.data = { data: [makeEntry('Note B', { 'note.due': dateValue('2026-08-10') })], properties: props };
		view.onDataUpdated();
		check('값이 있으면 플레이스홀더를 세우지 않는다', placeholder(cellEls(rowEl(containerEl))[1]) === null);
		view.unload();
	}

	{
		// 1·3(8차). 셀 밖으로 새는 것을 막는 규칙 — 명시도·박스 계산이라 DOM 으로는 안 잡힌다.
		// 알약 컨테이너는 코어가 폼 필드로 칠하는 클래스(.multi-select-container)를 빌려 쓰므로 리셋이 필수다.
		const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		// 주석은 걷어낸다 — 설명문이 안티패턴을 그대로 인용하고 있어 선언과 구분되지 않는다.
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector) => {
			const at = css.indexOf(selector);
			return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
		};
		const chips = block('.bases-plus-cell .bases-plus-chips,');
		const textarea = block('.bases-plus-cell .bases-plus-cell-textarea {');
		const editing = block('.bases-plus-row > .bases-plus-cell.is-editing {');

		check('알약 칸이 코어 폼 필드 배경을 지운다', chips.indexOf('background: transparent') !== -1);
		check('알약 칸이 코어 테두리·모서리를 지운다', chips.indexOf('border: none') !== -1 && chips.indexOf('border-radius: 0') !== -1);
		check('알약 칸이 코어 여백을 지운다', chips.indexOf('padding: 0') !== -1);
		check('알약 칸이 셀 폭을 넘지 않는다', chips.indexOf('max-width: 100%') !== -1);
		check('여러 줄 편집기가 셀 폭을 넘지 않는다', textarea.indexOf('max-width: 100%') !== -1 && textarea.indexOf('box-sizing: border-box') !== -1);
		check('편집 중 칸은 가로로 새지 않는다 (높이만 자란다)', editing.indexOf('overflow: hidden') !== -1 && editing.indexOf('overflow: visible') === -1);
		check('빈 날짜 플레이스홀더는 평시에 숨는다 (네이티브와 같은 조건)', block('.bases-plus-cell .bases-plus-empty-date {').indexOf('opacity: 0') !== -1);
		check('빈 날짜 플레이스홀더는 호버에서 드러난다', css.indexOf('.bases-plus-cell:hover .bases-plus-empty-date') !== -1);
	}

	{
		// 5. 셀 호버 배경이 **불투명하면** 행 구분선을 덮는다 — 셀은 flex 항목이라 블록 배경보다 나중에
		// 칠해지기 때문이다. 프리뷰 픽셀 실측으로 잡았고(호버 열 y=60 이 rgb(255,255,255)), 반투명 색으로 고쳤다.
		const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const hoverRule = css.slice(css.indexOf('.bases-plus-cell.is-editable:hover'));
		const hoverBody = hoverRule.slice(0, hoverRule.indexOf('}'));

		check('셀 호버는 반투명 색을 쓴다', hoverBody.indexOf('--background-modifier-hover') !== -1, hoverBody.trim());
		check('셀 호버에 불투명 배경을 쓰지 않는다', hoverBody.indexOf('--bases-table-cell-background-active') === -1);
		check('편집 중 칸은 높이를 푼다 (여러 줄 편집기가 자랄 자리)', css.indexOf('.bases-plus-row > .bases-plus-cell.is-editing') !== -1);
		check('여러 줄 편집기 스타일이 있다', css.indexOf('.bases-plus-cell .bases-plus-cell-textarea') !== -1);
		check('알약 칸 스타일이 표시 상태용으로 있다', css.indexOf('.bases-plus-cell .bases-plus-chips') !== -1);
	}

	console.log('\n[25] 실기동 9차 피드백 — 편집 칸 불투명·표 라인·알약 자동 폭');
	resetStubs();
	{
		// 3(9차). 알약 칸의 자동 폭 — 안쪽 컨테이너가 스크롤 컨테이너라 값 요소의 scrollWidth 만 보면
		// 넘침이 거기서 끊긴다(프리뷰 실측: 값 요소 147 대 실제 필요 186). 자식의 넘침까지 봐야 한다.
		const props = ['file.name', 'note.tags'];
		const entry = makeEntry('Note A', { 'note.tags': listValue(['설계', '검수 대기']) });
		const { app } = makeApp('visible', null, { tags: 'tags' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cell = cellEls(rowEl(containerEl))[1];
		const valueEl = cell.find('bases-plus-value');

		// 프리뷰에서 실제로 나온 값을 그대로 넣는다. 알약 컨테이너는 다시 그릴 때마다 새로 만들어지므로
		// (`valueEl.empty()`), 생성 시점에 치수를 심어 "브라우저가 131 폭에 170 내용을 깔았다" 를 흉내 낸다.
		valueEl.scrollWidth = 147;
		valueEl.clientWidth = 147;
		const createDiv = valueEl.createDiv.bind(valueEl);
		valueEl.createDiv = (arg) => {
			const el = createDiv(arg);
			el.scrollWidth = 170;
			el.clientWidth = 131;
			return el;
		};
		view.onDataUpdated();

		// 170 + (147 − 131) = 186. 값 요소만 봤다면 147 이었다.
		check('알약 열은 안쪽 넘침까지 재서 폭을 정한다', headerEls(containerEl)[1].style.flex === '1 0 186px', headerEls(containerEl)[1].style.flex);
		view.unload();
	}

	resetStubs();
	{
		// 안쪽에 스크롤 컨테이너가 없는 평범한 칸은 값 요소의 scrollWidth 그대로다 — 회귀 방지.
		const props = ['file.name', 'note.status'];
		const entry = makeEntry('Note A', { 'note.status': textValue('진행중') });
		const { app } = makeApp('visible', null, { status: 'text' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);

		cellEls(rowEl(containerEl))[1].find('bases-plus-value').scrollWidth = 120;
		view.onDataUpdated();
		cellEls(rowEl(containerEl))[1].find('bases-plus-value').scrollWidth = 120;
		view.onDataUpdated();
		check('평범한 칸은 값 요소 폭 그대로다', headerEls(containerEl)[1].style.flex === '1 0 120px', headerEls(containerEl)[1].style.flex);
		view.unload();
	}

	{
		// 1·2(9차). 둘 다 명시도·박스 계산이라 DOM 으로는 안 잡힌다 — 규칙 모양을 직접 읽어 지킨다.
		const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector) => {
			const at = css.indexOf(selector);
			return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
		};

		// 1. 편집 칸 위 호버가 불투명 배경을 반투명으로 덮으면 아래 행이 비친다.
		check('호버 규칙이 편집 중인 칸을 제외한다', css.indexOf('.bases-plus-cell.is-editable:not(.is-editing):hover') !== -1);
		check('편집 칸을 안 빼는 옛 호버 규칙은 없다', css.indexOf('.bases-plus-cell.is-editable:hover') === -1);
		check('편집 칸 배경은 여전히 불투명 토큰이다', block('.bases-plus-cell.is-editing {').indexOf('--bases-table-cell-background-active') !== -1);

		// 2. 열 합이 화면보다 넓으면 행 상자가 화면에서 끝나 구분선이 잘린다.
		const table = block('.bases-plus-table {');
		check('표가 늘 내용 폭으로 선다', table.indexOf('width: max-content') !== -1, table.trim());
		check('좁을 때는 화면을 채운다', table.indexOf('min-width: 100%') !== -1);
		check('조건부 is-sized 규칙은 없어졌다', css.indexOf('.bases-plus-table.is-sized') === -1);
	}

	resetStubs();
	{
		// is-sized 클래스는 더 이상 붙이지 않는다 — CSS 에서 없어졌으므로 표식만 남으면 오해를 부른다.
		const props = ['file.name', 'note.status'];
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')], {
			get: (k) => (k === 'columnSize' ? { 'file.name': 260, 'note.status': 120 } : undefined),
		}, null, props);

		check('죽은 is-sized 표식을 붙이지 않는다', containerEl.find('bases-plus-table').hasClass('is-sized') === false);
		view.unload();
	}

	console.log('\n[26] 실기동 10차 — 입력칸 배경·커서·헤더 메뉴 제거');
	resetStubs();
	{
		// 2(10차 → T7 재작업). **글자를 치는 칸**에만 텍스트 커서를 준다. 10차에는 체크박스만 빼는 부정형이라
		// 날짜·시각이 텍스트 커서로 남아 "정리가 안 됐다" 로 보였다 — 긍정형(`is-typing`)으로 뒤집었다.
		// 프리뷰 실측(호버 시 커서): 이름 default · 텍스트 text · 날짜 default · 숫자 text · 목록 text ·
		//                          빈날짜 default · 체크박스 default · 빈체크박스 default · 수식 default
		const props = ['file.name', 'note.status', 'note.due', 'note.count', 'note.tags', 'note.done', 'note.빈체크', 'note.빈날짜', 'formula.calc'];
		const entry = makeEntry('Note A', {
			'note.status': textValue('진행중'),
			'note.due': dateValue('2026-08-10'),
			'note.count': numberValue(3),
			'note.tags': listValue(['a']),
			'note.done': boolValue(true),
			'note.빈체크': nullValue(),
			'note.빈날짜': nullValue(),
			'formula.calc': textValue('계산값'),
		});
		const { app } = makeApp('visible', null, {
			status: 'text', due: 'date', count: 'number', tags: 'tags',
			done: 'checkbox', 빈체크: 'checkbox', 빈날짜: 'date',
		});
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const typing = cellEls(rowEl(containerEl)).map((el) => el.hasClass('is-typing'));

		check('텍스트 칸은 치는 칸이다', typing[1] === true);
		check('숫자 칸은 치는 칸이다', typing[3] === true);
		check('목록 칸은 치는 칸이다', typing[4] === true);
		check('날짜 칸은 치는 칸이 아니다 (달력으로 고른다)', typing[2] === false, String(typing[2]));
		check('빈 날짜 칸도 치는 칸이 아니다', typing[7] === false, String(typing[7]));
		check('체크박스 칸은 치는 칸이 아니다', typing[5] === false);
		check('빈 체크박스 칸도 치는 칸이 아니다', typing[6] === false, String(typing[6]));
		check('이름·수식 칸에는 안 붙는다', typing[0] === false && typing[8] === false, typing.join('|'));
		view.unload();
	}

	{
		// 1·2(10차). 둘 다 상태(:hover)와 변수라 DOM 으로는 안 잡힌다 — 규칙을 직접 읽어 지킨다.
		const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector) => {
			const at = css.indexOf(selector);
			return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
		};
		const cell = block('.bases-plus-cell {');

		// 1. 코어 `input[type=...]:hover`(0,2,1)가 우리 리셋(0,2,0)을 이겨 흰 배경이 돌아온다.
		//    상태마다 싸우는 대신 변수를 꺼서 모든 상태를 한 번에 잡는다(네이티브 `.bases-search-row` 와 같은 방식).
		check('셀 안에서 폼 필드 배경 변수를 끈다', cell.indexOf('--background-modifier-form-field: transparent') !== -1, cell.trim());
		check('그 호버 변수까지 함께 끈다', cell.indexOf('--background-modifier-form-field-hover: transparent') !== -1);
		check('입력 테두리 변수도 끈다', cell.indexOf('--input-border-width: 0') !== -1);

		// 2. 텍스트 커서는 타이핑하는 자리에만.
		check('텍스트 커서는 치는 칸에만 건다', css.indexOf('.bases-plus-cell.is-typing:not(.is-editing):hover') !== -1);
		check('편집 가능 칸 전체에 텍스트 커서를 걸던 옛 규칙은 없다', block('.bases-plus-cell.is-editable:not(.is-editing):hover').indexOf('cursor: text') === -1);
		// `--cursor` 를 정의하지 않는 테마에서 선언이 통째로 무효가 되면 커서가 상속(auto)으로 떨어진다.
		check('커서 토큰에 폴백을 둔다', css.indexOf('var(--cursor)') === -1 && css.indexOf('var(--cursor, default)') !== -1);

		// 3. 헤더 메뉴 모듈이 통째로 없어졌다.
		check('columnMenu 모듈이 남아 있지 않다', require('fs').existsSync(require('path').join(__dirname, '..', 'src', 'views', 'columnMenu.ts')) === false);

		/*
		 * 마무리 요구 — **알약은 말줄임하지 않는다.** 줄어들던 경로가 둘이라 둘 다 막혔는지 본다.
		 * ① 코어 `.multi-select-pill { max-width: calc(100% - …) }` 가 알약을 칸 폭에 묶는다
		 * ② 우리가 6차에 넣은 `text-overflow: ellipsis` 가 그 넘침을 …로 그렸다
		 * 프리뷰 실측 — 고치기 전: 알약 141px · 내용 109/162 잘림 · text-overflow ellipsis
		 *              고친 뒤:   알약 194px · 내용 162/162 · text-overflow clip · max-width none
		 */
		const pill = block('.bases-plus-cell .multi-select-pill {');
		const pillContent = block('.bases-plus-cell .multi-select-pill-content');

		check('알약이 칸 폭에 묶이지 않는다', pill.indexOf('max-width: none') !== -1, pill.trim());
		check('알약은 줄어들지 않는다', pill.indexOf('flex: 0 0 auto') !== -1);
		check('알약 내용에 말줄임을 걸지 않는다', pillContent.indexOf('text-overflow: ellipsis') === -1, pillContent.trim());
		check('알약 내용을 잘라 감추지도 않는다', pillContent.indexOf('overflow: hidden') === -1);
		// 한 줄 유지는 남겨야 한다 — 없으면 코어 word-break 가 알약을 여러 줄로 접어 행 높이를 넘긴다.
		check('알약은 한 줄로 유지한다', pillContent.indexOf('white-space: nowrap') !== -1);
		// 넘칠 때는 알약이 아니라 컨테이너가 가로로 흐른다(현행 구조 유지).
		check('넘치면 컨테이너가 가로로 흐른다', block('.bases-plus-cell .bases-plus-chips,').indexOf('overflow-x: auto') !== -1);
	}

	console.log('\n[27] 페이징 — 푸터 바·페이저 (디자인 B)');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, manyEntries, { stored: { rowLimit: 'pages', pageSize: '10' } });
		const bar = footerOf(containerEl);

		check('넘길 것이 있으면 푸터 바가 선다', bar !== null);
		check('푸터는 표 아래·오류 줄 위다', containerEl.find('bases-plus-view').children.map((el) => Array.from(el.classes)[0]).join('|') === 'bases-plus-notice|bases-plus-table|bases-plus-footer|bases-plus-error', containerEl.find('bases-plus-view').children.map((el) => Array.from(el.classes)[0]).join('|'));
		check('담는 것은 페이저 하나뿐이다 (총 개수를 또 쓰지 않는다)', bar.find('bases-plus-footer-bar').children.length === 3);
		check('첫 페이지에서는 이전 버튼이 눌리지 않는다', pagerButtons(bar)[0].disabled === true);
		check('넘길 페이지가 남아 있으면 다음 버튼은 살아 있다', pagerButtons(bar)[1].disabled === false);
		check('페이지 표시는 접근성 이름을 갖는다', bar.find('bases-plus-pager-page').attrs['aria-label'] === 'Page 1 of 3');
		check('버튼에도 접근성 이름이 있다', pagerButtons(bar).map((el) => el.attrs['aria-label']).join('|') === 'Previous page|Next page');
		check('페이지 표시는 키보드로도 닿는다', bar.find('bases-plus-pager-page').attrs.role === 'button' && bar.find('bases-plus-pager-page').attrs.tabindex === '0');

		pagerButtons(footerOf(containerEl))[1].dispatch('click');
		check('다음을 누르면 한 페이지 넘어간다', viewPagerText(containerEl) === '2 / 3', String(viewPagerText(containerEl)));
		check('그 페이지의 행이 나온다', cellText(visibleRowEls(containerEl)[0], 0) === 'Note 10', cellText(visibleRowEls(containerEl)[0], 0));

		pagerButtons(footerOf(containerEl))[1].dispatch('click');
		check('마지막 페이지에서는 다음 버튼이 눌리지 않는다', pagerButtons(footerOf(containerEl))[1].disabled === true);
		check('마지막 페이지는 남은 행만 그린다', visibleRowEls(containerEl).length === 5, String(visibleRowEls(containerEl).length));

		pagerButtons(footerOf(containerEl))[0].dispatch('click');
		check('이전을 누르면 되돌아간다', viewPagerText(containerEl) === '2 / 3');

		// 페이지는 보는 위치이지 뷰 설정이 아니다 — 저장하지 않는다(B4).
		check('현재 페이지를 .base 에 쓰지 않는다', JSON.stringify(view.config.stored) === '{"rowLimit":"pages","pageSize":"10"}', JSON.stringify(view.config.stored));
		view.unload();
	}

	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, manyEntries, { stored: { rowLimit: 'pages', pageSize: '5' } });

		// 페이지 표시를 누르면 그 자리가 입력칸이 된다 — 셀과 같은 편집 계약이다(B3).
		footerOf(containerEl).find('bases-plus-pager-page').dispatch('click');
		let input = footerOf(containerEl).find('bases-plus-pager-input');
		check('페이지 표시를 누르면 입력칸이 된다', input !== null && input.focused === true);
		check('현재 번호가 초기값이다', input.value === '1');

		input.value = '4';
		input.dispatch('keydown', { key: 'Enter' });
		check('Enter 면 그 페이지로 간다', viewPagerText(containerEl) === '4 / 5', String(viewPagerText(containerEl)));

		footerOf(containerEl).find('bases-plus-pager-page').dispatch('click');
		input = footerOf(containerEl).find('bases-plus-pager-input');
		input.value = '99';
		input.dispatch('keydown', { key: 'Enter' });
		check('범위 밖 숫자는 가장 가까운 페이지로 당긴다', viewPagerText(containerEl) === '5 / 5', String(viewPagerText(containerEl)));

		footerOf(containerEl).find('bases-plus-pager-page').dispatch('click');
		input = footerOf(containerEl).find('bases-plus-pager-input');
		input.value = '1';
		input.dispatch('keydown', { key: 'Escape' });
		check('Escape 면 취소하고 표시로 돌아간다', viewPagerText(containerEl) === '5 / 5' && footerOf(containerEl).find('bases-plus-pager-input') === null);

		// 조합 중 Enter 는 글자를 확정하는 키다 — 셀 편집기와 같은 가드(6차 3번).
		footerOf(containerEl).find('bases-plus-pager-page').dispatch('click');
		input = footerOf(containerEl).find('bases-plus-pager-input');
		input.value = '2';
		input.dispatch('keydown', { key: 'Enter', isComposing: true });
		check('조합 중 Enter 는 입력칸을 닫지 않는다', footerOf(containerEl).find('bases-plus-pager-input') !== null);
		check('조합 중 Enter 로는 이동하지 않는다', cellText(visibleRowEls(containerEl)[0], 0) === 'Note 20', cellText(visibleRowEls(containerEl)[0], 0));
		input.dispatch('keydown', { key: 'Enter' });
		check('조합이 끝난 Enter 는 이동한다', viewPagerText(containerEl) === '2 / 5', String(viewPagerText(containerEl)));

		// 포커스 이탈은 Enter 와 같다 — 셀 편집과 같은 규칙.
		footerOf(containerEl).find('bases-plus-pager-page').dispatch('click');
		input = footerOf(containerEl).find('bases-plus-pager-input');
		input.value = '3';
		input.dispatch('blur');
		check('포커스 이탈은 Enter 와 같다', viewPagerText(containerEl) === '3 / 5', String(viewPagerText(containerEl)));

		// 페이지 크기를 키우면 현재 페이지가 범위를 넘는다 — 빈 페이지 대신 마지막으로 당긴다(B4).
		view.config.stored.pageSize = '20';
		view.onDataUpdated();
		check('페이지 크기를 키우면 마지막 페이지로 당긴다', viewPagerText(containerEl) === '2 / 2', String(viewPagerText(containerEl)));

		view.config.stored.rowLimit = 'all';
		view.onDataUpdated();
		check('Show all 로 바꾸면 푸터가 사라진다', footerOf(containerEl) === null);
		check('그때는 전체 행이 나온다', visibleRowEls(containerEl).length === 25);
		view.unload();
	}

	console.log('\n[28] 그룹 조작 — 접기·그룹당 최대·그룹 페이징 (디자인 D)');
	/** 그룹 3개(2·1·1행)를 세운다 — 그룹 기준 속성명까지 보이도록 config.groupBy 도 함께 붙인다. */
	async function mountGrouped(stored, types) {
		const props = ['file.name', 'note.status'];
		const a = makeEntry('A', { 'note.status': textValue('진행중') });
		const b = makeEntry('B', { 'note.status': textValue('진행중') });
		const c = makeEntry('C', { 'note.status': textValue('완료') });
		const { app, frontmatter } = makeApp('visible', null, types);
		const mounted = await mount(app, [a, b, c], { stored: Object.assign({}, stored) }, null, props);

		mounted.view.config.groupBy = { property: 'note.status', direction: 'ASC' };
		mounted.view.data = {
			data: [a, b, c],
			properties: props,
			groupedData: [
				{ key: textValue('진행중'), hasKey: () => true, entries: [a, b] },
				{ key: textValue('완료'), hasKey: () => true, entries: [c] },
			],
		};
		mounted.view.onDataUpdated();

		return Object.assign(mounted, { app, frontmatter, entries: [a, b, c] });
	}

	resetStubs();
	{
		const { view, containerEl, config } = await mountGrouped();
		const headings = headingEls(containerEl);

		check('헤딩에 접기 화살표가 붙는다', headings[0].find('bases-plus-group-toggle') !== null);
		check('코어와 같은 글리프를 쓴다', headings[0].find('bases-plus-group-toggle').iconName === 'right-triangle');
		check('헤딩이 누르는 자리가 된다', headings[0].attrs.role === 'button' && headings[0].attrs.tabindex === '0');
		check('펴진 상태를 보조기술에 알린다', headings[0].attrs['aria-expanded'] === 'true');

		headings[0].dispatch('click');
		const collapsed = headingEls(containerEl);
		check('헤딩을 누르면 접힌다', collapsed[0].hasClass('is-collapsed'));
		check('접힌 상태를 보조기술에 알린다', collapsed[0].attrs['aria-expanded'] === 'false');
		check('접힘을 .base 에 저장한다 (다시 열어도 접힌 채)', JSON.stringify(config.stored.collapsedGroups) === '["진행중"]', JSON.stringify(config.stored.collapsedGroups));
		check('그 그룹 행만 감춘다', visibleRowEls(containerEl).length === 1, String(visibleRowEls(containerEl).length));
		// 요소 풀 재사용 구조를 깨지 않는다 — 지우는 것이 아니라 감춘다(성2 · D2).
		check('접힌 행을 DOM 에서 지우지 않는다', containerEl.findAll('bases-plus-row').length === 3);
		check('다른 그룹은 그대로다', collapsed[1].hasClass('is-collapsed') === false);

		collapsed[0].dispatch('keydown', { key: 'Enter' });
		check('Enter 로도 편다', headingEls(containerEl)[0].hasClass('is-collapsed') === false);
		check('전부 펴면 설정 키를 지운다', config.stored.collapsedGroups === undefined, JSON.stringify(config.stored));

		headingEls(containerEl)[0].dispatch('keydown', { key: ' ' });
		check('Space 로도 접는다', headingEls(containerEl)[0].hasClass('is-collapsed'));
		view.unload();
	}

	resetStubs();
	{
		// 저장된 접힘은 처음 그릴 때부터 먹는다.
		const { view, containerEl } = await mountGrouped({ collapsedGroups: ['완료'] });
		check('저장된 접힘을 그대로 복원한다', headingEls(containerEl)[1].hasClass('is-collapsed'));
		check('복원된 접힘도 행을 감춘다', visibleRowEls(containerEl).length === 2);
		view.unload();
	}

	resetStubs();
	{
		// F9 — 그룹마다 N개까지만. 나머지는 `Show all (N)` 로 편다.
		const { view, containerEl } = await mountGrouped({ rowLimit: 'group-top', groupSize: '1' });

		check('그룹마다 지정한 수만큼만 그린다', visibleRowEls(containerEl).length === 2, String(visibleRowEls(containerEl).length));
		const footers = groupFooterEls(containerEl);
		check('잘린 그룹에만 푸터 줄이 생긴다', footers.length === 1);
		// 괄호 안은 **그 그룹의 전체 행 수**다. 네이티브 buttonShowAllCount 를 빌린 우리 컨트롤 이름이라 영어다.
		check('문구가 Show all (전체 행 수) 다', footers[0].find('bases-plus-group-more').text === 'Show all (2)', footers[0].find('bases-plus-group-more').text);
		check('잘려도 헤딩 숫자는 그룹의 실제 크기다', headingEls(containerEl)[0].find('bases-plus-group-count').text === '2');

		footers[0].find('bases-plus-group-more').dispatch('click');
		check('누르면 그 그룹만 전부 펴진다', visibleRowEls(containerEl).length === 3);
		check('펴진 그룹에는 푸터가 없다', groupFooterEls(containerEl).length === 0);
		// 이번에 더 보려는 것이지 설정을 바꾸는 것이 아니다(D3).
		check('펼침은 저장하지 않는다', JSON.stringify(view.config.stored).indexOf('expand') === -1, JSON.stringify(view.config.stored));
		view.unload();
	}

	resetStubs();
	{
		// F10 — 그룹 안에서 넘긴다. 자리는 F9 의 그 줄이고 컨트롤만 페이저다.
		const { view, containerEl } = await mountGrouped({ rowLimit: 'group-pages', groupSize: '1' });
		const footers = groupFooterEls(containerEl);

		check('한 페이지에 다 들어가는 그룹에는 페이저를 안 만든다', footers.length === 1);
		check('그룹 페이저가 그 그룹만 센다', pagerTextOf(footers[0]) === '1 / 2', String(pagerTextOf(footers[0])));
		check('그룹 페이저는 뷰 푸터와 같은 컨트롤이다', footers[0].findAll('bases-plus-pager-button').length === 2);
		check('그룹 페이징일 때 뷰 푸터는 서지 않는다 (F3 와 배타)', footerOf(containerEl) === null);

		footers[0].findAll('bases-plus-pager-button')[1].dispatch('click');
		check('그룹 안에서 넘어간다', cellText(visibleRowEls(containerEl)[0], 0) === 'B', cellText(visibleRowEls(containerEl)[0], 0));
		check('다른 그룹 페이지는 그대로다', visibleRowEls(containerEl).length === 2);

		headingEls(containerEl)[0].dispatch('click');
		check('접으면 그룹 페이저도 함께 감춘다', groupFooterEls(containerEl).length === 0);
		view.unload();
	}

	resetStubs();
	{
		// 그룹 기준이 없는데 그룹 페이징을 고르면 안내 띠가 뜬다(A4).
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, manyEntries, { stored: { rowLimit: 'group-pages', groupSize: '5' } });
		const notice = containerEl.find('bases-plus-notice');

		check('그룹 없이 그룹 페이징을 고르면 안내가 뜬다', notice.hidden === false && notice.text === 'Group paging needs a group. Choose Group by in the toolbar.', notice.text);
		check('안내는 표보다 앞에 온다', containerEl.find('bases-plus-view').children[0] === notice);

		view.config.stored.rowLimit = 'all';
		view.onDataUpdated();
		check('조건이 풀리면 안내를 감춘다', containerEl.find('bases-plus-notice').hidden === true);
		view.unload();
	}

	console.log('\n[29] 수동 순서 — 행·그룹 드래그 (디자인 C·D5)');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const entries = ['A', 'B', 'C'].map((name) => makeEntry(name));
		const { view, containerEl, config } = await mount(app, entries, { stored: { manualOrderEnabled: true } });
		const rows = visibleRowEls(containerEl);

		check('순서 모드면 뷰에 표식이 붙는다 (표 전체가 같이 민다)', containerEl.find('bases-plus-view').hasClass('is-ordering'));
		check('행마다 손잡이가 생긴다', rows.every((el) => handleOf(el) !== null));
		check('코어가 같은 목적에 쓰는 글리프다', handleOf(rows[0]).iconName === 'lucide-grip-vertical');
		check('손잡이는 키보드로도 닿는다', handleOf(rows[0]).attrs.role === 'button' && handleOf(rows[0]).attrs['aria-label'] === 'Reorder row');
		// 손잡이를 행 맨 앞에 넣으면 첫 셀이 `:first-child` 를 잃어 헤더와 본문 열이 갈라진다(C2 함정).
		check('손잡이는 셀들 뒤에 붙는다', rows[0].children[rows[0].children.length - 1] === handleOf(rows[0]));
		check('첫 셀이 여전히 첫 자식이다', rows[0].children[0].hasClass('bases-plus-cell'));
		check('안내 띠는 뜨지 않는다 (정렬이 없다)', containerEl.find('bases-plus-notice').hidden === true);

		layoutRows(rows, 30);
		const handle = handleOf(rows[2]);
		handle.dispatch('pointerdown', { pointerId: 4, button: 0 });
		check('끄는 동안 손잡이가 강조된다', handle.hasClass('is-active'));
		check('잡힌 행에 표식이 붙는다', rows[2].hasClass('is-being-dragged'));
		check('포인터를 캡처한다 (창 밖으로 나가도 이어지게)', handle.captured === 4);
		check('드롭 표시자가 켜진다', containerEl.find('bases-plus-drop-indicator').hasClass('is-active'));
		check('끄는 중에는 아직 저장하지 않는다', config.stored.manualOrder === undefined);

		handle.dispatch('pointermove', { pointerId: 4, clientY: 5 });
		check('표시자가 포인터가 지나는 경계로 간다', containerEl.find('bases-plus-drop-indicator').style.top === '0px', containerEl.find('bases-plus-drop-indicator').style.top);

		handle.dispatch('pointerup', { pointerId: 4 });
		// 저장은 놓을 때 한 번뿐이다 — 끄는 동안 저장하면 `.base`(임베드에서는 노트)를 그만큼 다시 쓴다.
		check('놓을 때 한 번 저장한다', JSON.stringify(config.stored.manualOrder) === '["notes/C.md","notes/A.md","notes/B.md"]', JSON.stringify(config.stored.manualOrder));
		check('화면 순서도 그대로 따라간다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'CAB', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join(''));
		check('놓으면 표시자를 끈다', containerEl.find('bases-plus-drop-indicator').hasClass('is-active') === false);
		check('놓으면 포인터 캡처를 푼다', handle.captured === null);

		// 손잡이에 포커스를 두고 화살표 키로도 한 칸씩 옮긴다(C3).
		const moved = visibleRowEls(containerEl);
		layoutRows(moved, 30);
		handleOf(moved[0]).dispatch('keydown', { key: 'ArrowDown' });
		check('화살표 키로 한 칸 옮기고 즉시 저장한다', JSON.stringify(view.config.stored.manualOrder) === '["notes/A.md","notes/C.md","notes/B.md"]', JSON.stringify(view.config.stored.manualOrder));

		// 저장된 순서는 다시 그려도 남는다.
		view.data = { data: entries, properties: DEFAULT_PROPS };
		view.onDataUpdated();
		check('다시 그려도 저장된 순서로 선다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'ACB');

		// 저장된 순서에 없는 새 행은 뒤에 쿼리 순서대로 붙는다(C4).
		view.data = { data: entries.concat([makeEntry('D')]), properties: DEFAULT_PROPS };
		view.onDataUpdated();
		check('새 행은 저장된 것들 뒤에 붙는다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'ACBD');
		view.unload();
	}

	resetStubs();
	{
		// 끄는 중 Escape 는 원위치다. 저장하지 않는다(C3).
		const { app } = makeApp('visible');
		const { view, containerEl, config } = await mount(app, ['A', 'B'].map((n) => makeEntry(n)), { stored: { manualOrderEnabled: true } });
		const rows = visibleRowEls(containerEl);
		layoutRows(rows, 30);

		const handle = handleOf(rows[1]);
		handle.dispatch('pointerdown', { pointerId: 2, button: 0 });
		handle.dispatch('pointermove', { pointerId: 2, clientY: 1 });
		handle.dispatch('pointercancel', { pointerId: 2 });
		check('취소하면 저장하지 않는다', config.stored.manualOrder === undefined, JSON.stringify(config.stored));
		check('취소하면 표시자를 끈다', containerEl.find('bases-plus-drop-indicator').hasClass('is-active') === false);
		check('취소하면 잡힌 표식도 뗀다', rows[1].hasClass('is-being-dragged') === false);

		// 누르기만 하고 제자리에 놓으면 아무 일도 없다.
		handle.dispatch('pointerdown', { pointerId: 3, button: 0 });
		handle.dispatch('pointerup', { pointerId: 3 });
		check('제자리에 놓으면 저장하지 않는다', config.stored.manualOrder === undefined, JSON.stringify(config.stored));
		view.unload();
	}

	resetStubs();
	{
		// 정렬이 걸리면 손잡이가 사라지고 왜 지금 안 되는지 화면이 말한다(C1 · 확정 6).
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, ['A', 'B'].map((n) => makeEntry(n)), {
			stored: { manualOrderEnabled: true, manualOrder: ['notes/B.md'] },
			getSort: () => [{ property: 'file.name', direction: 'ASC' }],
		});

		check('정렬이 있으면 순서 모드가 살지 않는다', containerEl.find('bases-plus-view').hasClass('is-ordering') === false);
		check('왜 안 되는지 화면이 말한다', containerEl.find('bases-plus-notice').text === 'Manual order is paused while a sort is active. Clear the sort to reorder rows.', containerEl.find('bases-plus-notice').text);
		check('그동안 저장된 순서는 지우지 않는다', JSON.stringify(view.config.get('manualOrder')) === '["notes/B.md"]');
		check('정렬 중에는 쿼리 순서 그대로다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'AB');

		// 정렬을 지우면 저장된 순서가 그대로 돌아온다.
		view.config.getSort = () => [];
		view.onDataUpdated();
		check('정렬을 지우면 저장된 순서가 돌아온다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'BA');
		check('그때 안내도 사라진다', containerEl.find('bases-plus-notice').hidden === true);
		view.unload();
	}

	resetStubs();
	{
		// 드래그는 자기 그룹 안에서만이다 — 그룹을 넘기면 순서 변경이 아니라 값 편집이 된다(C4).
		// 행·그룹 순서는 이제 옵션이 따로다 — 이 절은 둘 다 켠 상태를 본다.
		const { view, containerEl, config } = await mountGrouped({ manualOrderEnabled: true, groupOrderEnabled: true });
		const rows = visibleRowEls(containerEl);
		layoutRows(rows, 30);

		const handle = handleOf(rows[2]);
		handle.dispatch('pointerdown', { pointerId: 8, button: 0 });
		check('다른 그룹 행은 옮길 후보에 들지 않는다 (혼자면 드래그가 시작되지 않는다)', handle.hasClass('is-active') === false);

		const inGroup = handleOf(rows[1]);
		inGroup.dispatch('pointerdown', { pointerId: 9, button: 0 });
		inGroup.dispatch('pointermove', { pointerId: 9, clientY: 1 });
		inGroup.dispatch('pointerup', { pointerId: 9 });
		check('같은 그룹 안에서는 옮겨진다', JSON.stringify(config.stored.manualOrder) === '["notes/B.md","notes/A.md","notes/C.md"]', JSON.stringify(config.stored.manualOrder));

		// 그룹 손잡이는 헤딩 + 그 그룹의 행 전부를 옮긴다(D5).
		const headings = headingEls(containerEl);
		layoutRows(headings, 40);
		const groupHandle = handleOf(headings[1]);
		groupHandle.dispatch('pointerdown', { pointerId: 10, button: 0 });
		groupHandle.dispatch('pointermove', { pointerId: 10, clientY: 1 });
		groupHandle.dispatch('pointerup', { pointerId: 10 });
		check('그룹 순서는 다른 키에 저장한다', JSON.stringify(config.stored.groupOrder) === '["완료","진행중"]', JSON.stringify(config.stored.groupOrder));
		check('그룹이 통째로 움직인다', headingEls(containerEl).map((el) => el.find('bases-plus-group-value').textContent).join('|') === '완료|진행중');
		check('그 그룹의 행도 따라온다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'CBA', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join(''));
		view.unload();
	}

	console.log('\n[30] 타입별 정렬 — 등록된 속성 타입 (디자인 E5)');
	resetStubs();
	{
		// 지금까지는 **그린 값**의 타입으로 정렬을 정해서 값이 빈 숫자 칸이 좌측에 남았다(명세가 지목한 결함 2번).
		const props = ['file.name', 'note.count', 'note.빈수', 'note.done', 'note.빈체크', 'formula.calc'];
		const entry = makeEntry('Note A', {
			'note.count': numberValue(3),
			'note.빈수': nullValue(),
			'note.done': boolValue(true),
			'note.빈체크': nullValue(),
			'formula.calc': numberValue(9),
		});
		const { app } = makeApp('visible', null, { count: 'number', 빈수: 'number', done: 'checkbox', 빈체크: 'checkbox' });
		const { view, containerEl } = await mount(app, [entry], null, null, props);
		const cells = cellEls(rowEl(containerEl));
		const typeOf = (i) => cells[i].attrs['data-property-type'];

		check('셀에 등록된 속성 타입을 심는다', typeOf(1) === 'number', String(typeOf(1)));
		check('값이 비어도 등록 타입은 그대로다', typeOf(2) === 'number', String(typeOf(2)));
		check('체크박스 열도 등록 타입으로 잡힌다', typeOf(4) === 'checkbox', String(typeOf(4)));
		// file.*·formula.* 는 등록된 위젯이 없다 — 그 열은 값 타입이 정렬을 잡는다.
		check('수식 열에는 등록 타입이 없다', typeOf(5) === null, String(typeOf(5)));
		check('수식 열은 값 타입으로 잡힌다', cells[5].attrs['data-value-type'] === 'number');
		check('이름 열에도 등록 타입이 없다', typeOf(0) === null, String(typeOf(0)));
		view.unload();
	}

	console.log('\n[31] 목록값 순서 — 열 메뉴·대화상자·적용 (디자인 F)');
	/** 목록 타입 열 하나를 가진 표. 값은 셋이고 한 노트가 값 하나씩만 갖는다(F5 가 깔끔하다고 한 그 사용). */
	async function mountList(stored) {
		const props = ['file.name', 'note.stage'];
		const entries = [
			makeEntry('A', { 'note.stage': listValue(['검수']) }),
			makeEntry('B', { 'note.stage': listValue(['기획']) }),
			makeEntry('C', { 'note.stage': listValue(['진행']) }),
		];
		const { app } = makeApp('visible', null, { stage: 'multitext' });
		const mounted = await mount(app, entries, { stored: Object.assign({}, stored) }, null, props);

		return Object.assign(mounted, { app, entries, props });
	}

	resetStubs();
	{
		const { view, containerEl } = await mountList();

		headerEls(containerEl)[1].dispatch('contextmenu');
		check('목록 타입 열에는 메뉴가 뜬다', Menu.instances.length === 1 && Menu.instances[0].items.length === 1);
		check('항목 문구가 명세 그대로다', Menu.instances[0].items[0].title === 'Set value order...');
		check('아이콘이 번호 매긴 목록이다', Menu.instances[0].items[0].icon === 'lucide-list-ordered');
		check('네이티브 열 메뉴와 같은 섹션이다', Menu.instances[0].items[0].section === 'action');

		Menu.instances.length = 0;
		// 흐리게 남겨 두면 "왜 안 되지"를 묻게 만든다 — 항목이 없으면 메뉴 자체를 만들지 않는다(F2).
		headerEls(containerEl)[0].dispatch('contextmenu');
		check('목록 타입이 아닌 열에는 메뉴 자체가 없다', Menu.instances.length === 0, String(Menu.instances.length));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl, config } = await mountList();

		headerEls(containerEl)[1].dispatch('contextmenu');
		Menu.instances[0].items[0].click();
		const modal = Modal.instances[Modal.instances.length - 1];
		const items = modal.contentEl.findAll('bases-plus-value-order-item');

		check('대화상자가 뜬다', modal.isOpen);
		check('껍데기를 노트 모달과 공유한다', modal.modalEl.hasClass('bases-plus-modal'));
		check('제목이 그 열 이름이다', modal.contentEl.find('bases-plus-modal-title').text === 'stage');
		check('되돌리기 버튼이 확정분 액션 버튼이다', modal.contentEl.find('bases-plus-modal-action').textContent === 'Reset order');
		// 후보는 지금 쿼리 결과에 실제로 나타난 값뿐이고, 저장 전에는 사전순이다(F3).
		check('쿼리에 나온 값만 사전순으로 모은다', items.map((el) => el.attrs['data-value']).join('|') === '검수|기획|진행', items.map((el) => el.attrs['data-value']).join('|'));
		check('줄마다 손잡이가 있다', items.every((el) => handleOf(el) !== null));
		check('손잡이는 행 순서와 같은 어휘다', handleOf(items[0]).iconName === 'lucide-grip-vertical');
		// 저장·확인 버튼이 없다 — 이 플러그인에 확인 버튼이 있는 화면은 하나도 없다(F3).
		check('확인 버튼이 없다', modal.contentEl.findAll('bases-plus-modal-action').length === 1);

		layoutRows(items, 30);
		handleOf(items[2]).dispatch('keydown', { key: 'ArrowUp' });
		check('순서를 바꾸면 그 자리에서 저장한다', JSON.stringify(config.stored.listValueOrder) === '{"note.stage":["검수","진행","기획"]}', JSON.stringify(config.stored.listValueOrder));
		check('저장 키가 listValueOrder 다 (예약 이름과 겹치면 base 가 안 열린다)', Object.keys(config.stored).indexOf('order') === -1 && 'listValueOrder' in config.stored);

		modal.contentEl.find('bases-plus-modal-action').dispatch('click');
		check('되돌리면 저장된 순서를 지운다', config.stored.listValueOrder === undefined, JSON.stringify(config.stored));
		check('되돌리면 사전순으로 돌아간다', modal.contentEl.findAll('bases-plus-value-order-item').map((el) => el.attrs['data-value']).join('|') === '검수|기획|진행');

		modal.close();
		view.unload();
	}

	resetStubs();
	{
		// 값이 하나뿐이면 순서를 정할 것이 없다 — 손잡이를 감춘다(F3). 값이 없으면 사과가 아니라 안내다.
		const props = ['file.name', 'note.stage'];
		const { app } = makeApp('visible', null, { stage: 'multitext' });
		const { view, containerEl } = await mount(app, [makeEntry('A', { 'note.stage': nullValue() })], null, null, props);

		headerEls(containerEl)[1].dispatch('contextmenu');
		Menu.instances[0].items[0].click();
		const modal = Modal.instances[Modal.instances.length - 1];
		check('값이 없으면 안내 한 줄만 남는다', modal.contentEl.find('bases-plus-value-order-empty') !== null);
		check('값이 없으면 줄도 없다', modal.contentEl.findAll('bases-plus-value-order-item').length === 0);
		modal.close();
		view.unload();
	}

	resetStubs();
	{
		// 그 열이 **정렬 열일 때만** 행 정렬에 걸린다. 정렬 열이 아니면 아무 일도 없다(F4).
		const order = { 'note.stage': ['진행', '검수', '기획'] };
		const { view, containerEl } = await mountList({ listValueOrder: order });
		const names = () => visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('');

		check('정렬 열이 아니면 화면이 저절로 바뀌지 않는다', names() === 'ABC', names());

		view.config.getSort = () => [{ property: 'note.stage', direction: 'ASC' }];
		view.onDataUpdated();
		check('그 열로 정렬하면 정한 순서대로 선다', names() === 'CAB', names());

		view.config.getSort = () => [{ property: 'note.stage', direction: 'DESC' }];
		view.onDataUpdated();
		// 툴바의 오름·내림 표시가 그 열에 남아 있다 — DESC 가 아무 일도 안 하면 화면 표시가 거짓말이 된다(F4).
		check('내림차순은 뒤집는다', names() === 'BAC', names());

		view.config.getSort = () => [{ property: 'file.name', direction: 'ASC' }];
		view.onDataUpdated();
		check('다른 열로 정렬하면 걸리지 않는다', names() === 'ABC', names());
		view.unload();
	}

	resetStubs();
	{
		// 순서 목록에 없는 값은 맨 뒤에 사전순이다 — 나중에 생긴 값이 조용히 맨 앞에 끼어들지 않게(F5).
		const { view, containerEl } = await mountList({ listValueOrder: { 'note.stage': ['진행'] } });
		view.config.getSort = () => [{ property: 'note.stage', direction: 'ASC' }];
		view.onDataUpdated();
		check('정한 값이 앞, 나머지는 사전순으로 뒤', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'CAB', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join(''));

		view.config.stored.listValueOrder = { 'note.stage': 'not-an-array' };
		view.onDataUpdated();
		check('형태가 깨지면 없는 것으로 보고 떨어진다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'ABC');
		view.unload();
	}

	resetStubs();
	{
		// 그룹 헤딩 순서에도 적용된다(F4). 그룹 키는 목록 전체가 조합 하나라 값 하나짜리에서만 깔끔하다(F5).
		const props = ['file.name', 'note.stage'];
		const a = makeEntry('A', { 'note.stage': listValue(['검수']) });
		const b = makeEntry('B', { 'note.stage': listValue(['기획']) });
		const { app } = makeApp('visible', null, { stage: 'multitext' });
		const { view, containerEl } = await mount(app, [a, b], {
			stored: { listValueOrder: { 'note.stage': ['기획', '검수'] } },
		}, null, props);

		view.config.groupBy = { property: 'note.stage', direction: 'ASC' };
		view.data = {
			data: [a, b],
			properties: props,
			groupedData: [
				{ key: listValue(['검수']), hasKey: () => true, entries: [a] },
				{ key: listValue(['기획']), hasKey: () => true, entries: [b] },
			],
		};
		view.onDataUpdated();
		const headingNames = () => headingEls(containerEl).map((el) => el.find('bases-plus-group-value').textContent).join('|');

		check('그룹 헤딩이 정한 순서대로 선다', headingNames() === '기획|검수', headingNames());
		check('그룹의 행도 함께 따라온다', visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('') === 'BA');
		view.unload();
	}

	console.log('\n[32] 새 컨트롤의 CSS — 명시도·변수·축 (규칙 모양으로 지킨다)');
	{
		// 아래 항목은 전부 computed 값이거나 상태(:hover·:disabled)라 DOM 으로는 안 잡힌다.
		const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector) => {
			const at = css.indexOf(selector);
			return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
		};

		// 축은 상자가 아니라 잉크다 — 줄마다 lead 가 다른 이유가 이것이다(A2·A3).
		const gutterRule = block('.bases-plus-thead,\n.bases-plus-row,\n.bases-plus-group-heading,');
		check('여백 열을 변수 하나로 잡는다', block('.bases-plus-view {').indexOf('--bases-plus-order-gutter: 0px') !== -1);
		check('순서 모드에서만 여백 열이 생긴다', block('.bases-plus-view.is-ordering {').indexOf('--bases-plus-order-gutter: var(--table-drag-handle-size, var(--size-4-4))') !== -1);
		// `--table-drag-handle-size` 는 `.cm-table-widget` 안에서만 정의돼 있다 — 폴백이 없으면 선언이 통째로 죽는다.
		check('없는 토큰에 폴백을 둔다', css.indexOf('var(--table-drag-handle-size)') === -1);
		check('다섯 줄이 같은 여백을 함께 받는다', gutterRule.indexOf('padding-inline-start: calc(var(--bases-plus-order-gutter) + var(--bases-plus-lead, 0px))') !== -1, gutterRule.trim());
		// `.bases-plus-footer-bar {` 는 위 여백 규칙의 셀렉터 목록 끝에도 나온다 — 선언까지 함께 본다.
		check('줄마다 자기 lead 를 정의한다', /\.bases-plus-footer-bar \{\s*--bases-plus-lead: var\(--size-2-1\)/.test(css) && block('.bases-plus-group-footer {').indexOf('--bases-plus-lead: var(--size-2-2)') !== -1);
		check('그룹 푸터는 들어가는 컨트롤에 따라 lead 가 갈린다', block('.bases-plus-group-footer.is-paged {').indexOf('--bases-plus-lead: var(--size-2-1)') !== -1);
		check('그룹 헤딩의 8px 이 lead 로 옮겨 갔다', block('.bases-plus-group-heading {').indexOf('--bases-plus-lead: var(--size-4-2)') !== -1);

		// 절대 배치 손잡이·드롭 표시자는 기준이 될 조상이 있어야 선다.
		check('행이 손잡이의 기준이 된다', block('.bases-plus-row {').indexOf('position: relative') !== -1);
		check('행 컨테이너가 드롭 표시자의 기준이 된다', block('.bases-plus-rows {').indexOf('position: relative') !== -1);
		check('순서 모드가 아니면 손잡이를 아예 안 그린다', css.indexOf('.bases-plus-view:not(.is-ordering) .bases-plus-order-handle') !== -1);
		check('손잡이는 터치로 끌 때 표를 같이 스크롤하지 않는다', block('.bases-plus-order-handle {').indexOf('touch-action: none') !== -1);
		check('드롭 표시자는 평시에 숨는다', block('.bases-plus-drop-indicator:not(.is-active)').indexOf('display: none') !== -1);

		// 페이저는 네이티브 어휘를 토큰째 옮긴 것이다.
		const footer = block('.bases-plus-footer {');
		check('푸터가 바닥에 고정된다', footer.indexOf('position: sticky') !== -1 && footer.indexOf('bottom: 0') !== -1);
		check('푸터 배경·선이 네이티브 바닥 줄과 같다', footer.indexOf('--bases-table-summary-background') !== -1 && footer.indexOf('--bases-table-border-color') !== -1);
		check('페이저 입력칸 리셋이 두 단이다 (코어 input[type=text] 를 이겨야 한다)', css.indexOf('.bases-plus-pager-page .bases-plus-pager-input {') !== -1);
		check('비활성 버튼은 흐려진다', block('.bases-plus-pager-button:disabled').indexOf('--text-faint') !== -1);
		check('모바일에서 아이콘 척도를 코어와 같이 올린다', css.indexOf('.is-mobile .bases-plus-footer') !== -1);

		// 접기 화살표 — 코어 collapse-icon 의 선언을 옮겼다.
		const toggle = block('.bases-plus-group-toggle svg {');
		check('화살표 크기·굵기가 코어와 같다', toggle.indexOf('width: 10px') !== -1 && toggle.indexOf('stroke-width: 4px') !== -1);
		// zero-width space 는 장식이 아니다 — 헤딩이 baseline 정렬이라 svg 만 있는 항목은 기준선이 없어 튄다.
		check('기준선을 만드는 zero-width space 가 있다', block('.bases-plus-group-toggle:before').indexOf('\\200B') !== -1);
		check('접히면 화살표가 돈다', css.indexOf('.bases-plus-group-heading.is-collapsed .bases-plus-group-toggle svg') !== -1);
		check('모션을 줄인 환경에서는 회전을 끈다', css.indexOf('@media (prefers-reduced-motion: reduce)') !== -1);

		// 그룹 개수는 빌려 온 원본(--text-faint)에서 한 단계 올렸다 — 대비 2.20:1 로는 읽히지 않는다(I3).
		check('그룹 개수는 읽히는 색을 쓴다', block('.bases-plus-group-count {').indexOf('color: var(--text-muted)') !== -1);
		check('Show all 버튼 리셋도 두 단이다', css.indexOf('.bases-plus-group-footer .bases-plus-group-more {') !== -1);

		// 빈 숫자 칸이 좌측에 남던 결함 — 등록 타입과 값 타입을 함께 잡아야 고쳐진다(E5).
		check('정렬을 등록된 속성 타입으로도 잡는다', css.indexOf('.bases-plus-cell[data-property-type="number"] .bases-plus-value') !== -1);
		check('체크박스 가운데 정렬도 등록 타입을 본다', css.indexOf('.bases-plus-cell[data-property-type="checkbox"] .bases-plus-value') !== -1);

		// 모달 껍데기는 노트 모달과 값 순서 대화상자가 공유한다 — 크롬을 다시 짜면 중복이 된다.
		check('모달 껍데기가 공유 클래스로 선다', css.indexOf('.modal.bases-plus-modal {') !== -1);
		check('노트 모달은 크기만 따로 정한다', block('.modal.bases-plus-note-modal {').indexOf('--bases-plus-modal-inset') === -1);
		check('액션 버튼 규칙도 공유한다', css.indexOf('.bases-plus-modal .bases-plus-modal-action {') !== -1);
		// 코어가 쓰는 `:first-of-type:last-of-type` 은 여기서 못 쓴다 — 목록 안에 드롭 표시자 div 가 함께 있어
		// 항목이 하나여도 그 짝이 성립하지 않는다(규칙이 조용히 죽는다). 갯수는 목록이 클래스로 말한다.
		check('값 하나뿐이면 손잡이를 감춘다', css.indexOf('.bases-plus-value-order-list.is-single .bases-plus-order-handle') !== -1);
		check('요소 종류로 갯수를 세는 옛 규칙은 없다', css.indexOf(':first-of-type:last-of-type') === -1);

		// 사과하던 상태 줄은 규칙까지 없앤다 — 죽은 선언이 남으면 다음 사람이 살아 있는 줄 안다.
		check('.bases-plus-status 규칙이 남아 있지 않다', css.indexOf('.bases-plus-status') === -1);
	}

	console.log('\n[33] 실기동 1차 피드백 — 입력칸 배경·드롭 표시자 스크롤·그룹 순서 분리');
	resetStubs();
	{
		// 3(24번 + 추가 요구). 그룹 수동 순서를 **행과 독립된 옵션**으로 분리한다.
		const { view, containerEl, config, registration } = await mountGrouped();
		const options = registration.options(makeConfig());

		const groupToggle = options.find((o) => o.key === 'groupOrderEnabled');
		check('그룹 수동 순서 토글이 따로 있다', !!groupToggle && groupToggle.type === 'toggle');
		check('기본이 꺼짐이다', groupToggle.default === false);
		check('문구가 영어 컨트롤 이름이다 (D3-B)', groupToggle.displayName === 'Group manual order');
		check('옵션 순서 맨 뒤에 온다', options.map((o) => o.key).join(',') === 'openMode,rowLimit,pageSize,groupSize,manualOrderEnabled,groupOrderEnabled', options.map((o) => o.key).join(','));

		// 꺼져 있으면 그룹 손잡이가 뜨지 않는다.
		check('꺼져 있으면 그룹 순서 표식이 없다', containerEl.find('bases-plus-view').hasClass('is-group-ordering') === false);
		view.unload();
	}

	resetStubs();
	{
		// 행만 켜면 여백 열은 생기되 **행 손잡이만** 드러난다 — 축이 갈라지지 않게 열은 함께 밀린다.
		const { view, containerEl } = await mountGrouped({ manualOrderEnabled: true });
		const root = containerEl.find('bases-plus-view');

		check('행만 켜도 여백 열은 생긴다', root.hasClass('is-ordering'));
		check('행 손잡이 표식이 붙는다', root.hasClass('is-row-ordering'));
		check('그룹 손잡이 표식은 안 붙는다', root.hasClass('is-group-ordering') === false);
		view.unload();
	}

	resetStubs();
	{
		// 그룹만 켜도 마찬가지다 — 여백 열은 생기고 그룹 손잡이만 산다.
		const { view, containerEl } = await mountGrouped({ groupOrderEnabled: true });
		const root = containerEl.find('bases-plus-view');

		check('그룹만 켜도 여백 열은 생긴다', root.hasClass('is-ordering'));
		check('그룹 손잡이 표식이 붙는다', root.hasClass('is-group-ordering'));
		check('행 손잡이 표식은 안 붙는다', root.hasClass('is-row-ordering') === false);
		view.unload();
	}

	resetStubs();
	{
		/*
		 * 24번의 핵심 — **꺼져 있으면 저장된 groupOrder 를 읽지 않는다.** 예전 그룹 기준에서 끌어 둔 순서가
		 * 살아남아 새 기준의 값 순서를 덮는 상태를 구조에서 없앤다. 지우지는 않으므로 다시 켜면 돌아온다.
		 */
		const props = ['file.name', 'note.stage'];
		const a = makeEntry('A', { 'note.stage': listValue(['검수']) });
		const b = makeEntry('B', { 'note.stage': listValue(['기획']) });
		const { app } = makeApp('visible', null, { stage: 'multitext' });
		const { view, containerEl } = await mount(app, [a, b], {
			stored: {
				listValueOrder: { 'note.stage': ['기획', '검수'] },
				// 예전 그룹 기준(status)에서 끌어 저장된 순서가 남아 있는 상태를 그대로 만든다.
				groupOrder: ['검수', '기획'],
			},
		}, null, props);

		view.config.groupBy = { property: 'note.stage', direction: 'ASC' };
		view.data = {
			data: [a, b],
			properties: props,
			groupedData: [
				{ key: listValue(['검수']), hasKey: () => true, entries: [a] },
				{ key: listValue(['기획']), hasKey: () => true, entries: [b] },
			],
		};
		view.onDataUpdated();
		const headingNames = () => headingEls(containerEl).map((el) => el.find('bases-plus-group-value').textContent).join('|');

		check('꺼져 있으면 값 순서가 그룹에 그대로 보인다', headingNames() === '기획|검수', headingNames());
		check('저장된 groupOrder 를 지우지는 않는다', JSON.stringify(view.config.get('groupOrder')) === '["검수","기획"]');

		view.config.stored.groupOrderEnabled = true;
		view.onDataUpdated();
		check('켜면 저장해 둔 수동 순서가 돌아온다', headingNames() === '검수|기획', headingNames());
		view.unload();
	}

	resetStubs();
	{
		// 2(22번). 스크롤된 목록 위에서 드롭 표시자가 `scrollTop` 만큼 위에 그려지던 것을 고쳤다.
		// 브라우저 실측 — 스크롤 60 일 때 계산 60 · 실제 0(60px 어긋남). 그래서 오프셋을 더한다.
		const { view, containerEl, config } = await mountList();

		headerEls(containerEl)[1].dispatch('contextmenu');
		Menu.instances[0].items[0].click();
		const modal = Modal.instances[Modal.instances.length - 1];
		const listEl = modal.contentEl.find('bases-plus-value-order-list');
		const items = modal.contentEl.findAll('bases-plus-value-order-item');

		// 목록을 60px 만큼 스크롤한 상태를 만든다 — 그러면 브라우저가 주는 rect 는 그만큼 위로 올라간다.
		listEl.scrollTop = 60;
		items.forEach((el, i) => { el.offsetTop = i * 30 - 60; el.offsetHeight = 30; });

		const handle = handleOf(items[2]);
		handle.dispatch('pointerdown', { pointerId: 11, button: 0 });
		// 맨 위 경계로 끈다. 그 자리는 **내용 좌표 0** 이고 화면상으로는 -60 이다 —
		// 스크롤을 안 세면 표시자가 -60px 에 그려져 목록 밖으로 사라진다(마스터가 본 "잘못된 위치").
		handle.dispatch('pointermove', { pointerId: 11, clientY: -100 });
		const indicator = modal.contentEl.find('bases-plus-drop-indicator');
		check('스크롤 오프셋을 더해 제자리에 그린다', indicator.style.top === '0px', String(indicator.style.top));

		handle.dispatch('pointerup', { pointerId: 11 });
		check('이동 자체는 그대로 동작한다 (마스터도 여기는 정상이라 했다)', JSON.stringify(config.stored.listValueOrder) === '{"note.stage":["진행","검수","기획"]}', JSON.stringify(config.stored.listValueOrder));
		modal.close();
		view.unload();
	}

	resetStubs();
	{
		// 4(15번). 키보드로 옮기면 곧바로 다시 그리는데 요소 풀은 **자리 기준**이라 같은 요소가 다른 행을
		// 맡는다 — 옮긴 항목을 다시 찾아 포커스를 넘겨야 다음 화살표가 같은 행을 옮긴다.
		const { app } = makeApp('visible');
		const entries = ['A', 'B', 'C'].map((n) => makeEntry(n));
		const { view, containerEl, config } = await mount(app, entries, { stored: { manualOrderEnabled: true } });
		const names = () => visibleRowEls(containerEl).map((el) => cellText(el, 0)).join('');

		let rows = visibleRowEls(containerEl);
		layoutRows(rows, 30);
		handleOf(rows[0]).dispatch('keydown', { key: 'ArrowDown' });
		check('한 칸 내려간다', names() === 'BAC', names());
		check('옮긴 행의 손잡이로 포커스가 따라간다', handleOf(visibleRowEls(containerEl)[1]).focused === true);

		// 같은 손잡이를 다시 눌러도 **같은 행**이 계속 내려가야 한다(예전에는 자리 기준이라 다른 행이 움직였다).
		layoutRows(visibleRowEls(containerEl), 30);
		handleOf(visibleRowEls(containerEl)[1]).dispatch('keydown', { key: 'ArrowDown' });
		check('같은 행이 이어서 내려간다', names() === 'BCA', names());
		check('끝에서는 더 내려가지 않는다', (() => {
			layoutRows(visibleRowEls(containerEl), 30);
			handleOf(visibleRowEls(containerEl)[2]).dispatch('keydown', { key: 'ArrowDown' });
			return names() === 'BCA';
		})(), names());
		check('키보드 이동도 바로 저장된다', JSON.stringify(config.stored.manualOrder) === '["notes/B.md","notes/C.md","notes/A.md"]', JSON.stringify(config.stored.manualOrder));
		view.unload();
	}

	{
		// 1(4번). 입력칸 배경은 상태·변수라 DOM 으로는 안 잡힌다 — 규칙 모양을 직접 읽어 지킨다.
		// 프리뷰 실측 — 고치기 전: 높이 30 = 푸터 30 · 위 간격 0 · 폼필드 변수 #ffffff(호버에서 흰 네모)
		//              고친 뒤:   높이 24 · 위 간격 3 · 변수 transparent
		const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
		const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
		const block = (selector) => {
			const at = css.indexOf(selector);
			return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
		};
		const page = block('.bases-plus-pager-page {');
		const input = block('.bases-plus-pager-page .bases-plus-pager-input {');

		check('페이지 칸 안에서 폼 필드 배경 변수를 끈다', page.indexOf('--background-modifier-form-field: transparent') !== -1, page.trim());
		check('그 호버 변수까지 함께 끈다', page.indexOf('--background-modifier-form-field-hover: transparent') !== -1);
		check('입력칸이 푸터 높이를 다 쓰지 않는다', input.indexOf('height: var(--input-height)') === -1 && input.indexOf('--icon-s') !== -1, input.trim());
		check('편집 중임은 배경이 아니라 링으로 말한다', block('.bases-plus-pager-page .bases-plus-pager-input:focus').indexOf('--background-modifier-border-focus') !== -1);

		// 행·그룹 손잡이가 각자 표식으로 갈린다.
		check('행 손잡이는 행 표식이 없으면 안 그린다', css.indexOf('.bases-plus-view:not(.is-row-ordering) .bases-plus-row > .bases-plus-order-handle') !== -1);
		check('그룹 손잡이는 그룹 표식이 없으면 안 그린다', css.indexOf('.bases-plus-view:not(.is-group-ordering) .bases-plus-group-heading > .bases-plus-order-handle') !== -1);
	}

	console.log('\n[34] 그룹 값 순서 — 툴바 방향 반영');
	/**
	 * 마스터 실기동과 같은 모양을 세운다 — 값 하나짜리 그룹과 **조합 키**(값 여러 개)가 섞인 tags 열.
	 * 조합 키는 값 순서 목록에 없으므로 순위가 없다(F5).
	 */
	async function mountTagGroups(stored) {
		const props = ['file.name', 'note.tags'];
		const keys = [['a'], ['기획'], ['표'], ['기획', '표'], ['검토', 'a']];
		const { app } = makeApp('visible', null, { tags: 'tags' });
		const entries = keys.map((items, i) => makeEntry('N' + i, { 'note.tags': listValue(items) }));
		const mounted = await mount(app, entries, { stored: Object.assign({}, stored) }, null, props);

		mounted.render = (direction) => {
			// Bases 는 방향대로 정렬해 groupedData 를 준다 — 우리 계층은 그 위에 자기 규칙을 얹는다.
			const ordered = keys.slice().sort((x, y) => {
				const c = x.join(', ').localeCompare(y.join(', '));
				return direction === 'DESC' ? -c : c;
			});
			mounted.view.config.groupBy = { property: 'note.tags', direction };
			mounted.view.data = {
				data: entries,
				properties: props,
				groupedData: ordered.map((items) => ({
					key: listValue(items),
					hasKey: () => true,
					entries: [entries[keys.findIndex((k) => k.join() === items.join())]],
				})),
			};
			mounted.view.onDataUpdated();

			return headingEls(mounted.containerEl).map((el) => el.find('bases-plus-group-value').textContent);
		};

		return mounted;
	}

	resetStubs();
	{
		// 값 순서를 정해 두고 툴바 방향만 뒤집는다 — 마스터가 한 그 조작이다.
		const { view, render } = await mountTagGroups({
			listValueOrder: { 'note.tags': ['표', '기획', 'a'] },
		});

		const asc = render('ASC');
		check('A-Z 는 정한 값 순서대로 선다', asc.slice(0, 3).join('|') === '표|기획|a', asc.join('|'));
		// 순위가 없는 조합 키는 맨 뒤에 **사전순**이다(F5) — 쿼리 순서로 두면 방향에 따라 저 혼자 뒤집힌다.
		check('조합 키는 맨 뒤에 사전순으로 붙는다', asc.slice(3).join('|') === '검토, a|기획, 표', asc.join('|'));

		const desc = render('DESC');
		/*
		 * 2차 C 의 실체 — 예전에는 방향을 바꿔도 **순위가 있는 그룹은 그대로**였고 조합 키만 움직여
		 * "부분 반영" 으로 보였다(재현: 단일 14칸 고정 · 조합 6칸만 이동). 이제 통째로 뒤집힌다.
		 * 툴바에 오름·내림 표시가 남아 있는데 아무 일도 없으면 화면의 표시가 거짓말이 된다(F4).
		 */
		check('Z-A 는 정확한 역순이다', desc.join('|') === asc.slice().reverse().join('|'), desc.join('|'));
		// 가운데 항목은 뒤집어도 제자리라 판정에 못 쓴다 — 순위가 있는 그룹 중 끝쪽을 본다.
		check('순위가 있는 그룹도 함께 움직인다', asc.indexOf('표') !== desc.indexOf('표'), `${asc.indexOf('표')} -> ${desc.indexOf('표')}`);
		check('맨 앞이 실제로 바뀐다', asc[0] !== desc[0], `${asc[0]} -> ${desc[0]}`);
		view.unload();
	}

	resetStubs();
	{
		// 값 순서가 없으면 방향은 쿼리 순서 그대로다 — 우리가 끼어들 이유가 없다.
		const { view, render } = await mountTagGroups();
		const asc = render('ASC');
		const desc = render('DESC');

		check('값 순서가 없으면 쿼리 순서를 그대로 쓴다', asc.join('|') === desc.slice().reverse().join('|'), asc.join('|'));
		view.unload();
	}

	resetStubs();
	{
		/*
		 * 수동으로 끌어 둔 그룹 순서는 방향이 뒤집지 않는다 — `groupOrder` 는 사용자가 만든 **최종 배치**라
		 * 방향으로 다시 뒤집으면 방금 놓은 자리와 싸운다. 뒤집고 싶으면 끌면 된다.
		 */
		const { view, render } = await mountTagGroups({
			groupOrderEnabled: true,
			groupOrder: ['a', '표', '기획'],
			listValueOrder: { 'note.tags': ['표', '기획', 'a'] },
		});

		const asc = render('ASC');
		const desc = render('DESC');
		check('수동 순서가 값 순서를 이긴다', asc.slice(0, 3).join('|') === 'a|표|기획', asc.join('|'));
		check('수동 순서는 방향에 뒤집히지 않는다', desc.slice(0, 3).join('|') === 'a|표|기획', desc.join('|'));
		view.unload();
	}

	console.log('\n[22] unload 정리');
	resetStubs();
	{
		const { app } = makeApp('visible');
		const { view, containerEl } = await mount(app, [makeEntry('Note A')]);
		const row = containerEl.findAll('bases-plus-row')[0];
		view.unload();

		check('뷰 루트를 컨테이너에서 뗀다', containerEl.find('bases-plus-view') === null);
		check('행 리스너를 푼다', row.listeners.length === 0);
	}

	await timelineTests();
	await calendarTests();
	await graphTests();
	await i18nTests();

	console.log(`\n결과 — 통과 ${pass} / 실패 ${failures.length}`);
	if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
}

// ── 타임라인 (2단계) ──────────────────────────────────────────────────────────────────
/** 왼쪽 판은 표 그 자체라 열 구성도 표와 같은 모양으로 둔다. */
const TL_PROPS = ['file.name', 'note.status'];
const TL_TYPES = { start: 'date', end: 'date', status: 'text' };
const UNIT_PX = 32;

/** `note.start`·`note.end` 는 날짜 값이다 — 뷰가 화면 글자가 아니라 값에서 날짜를 읽는 경로를 태운다. */
function tlEntry(name, start, end, status) {
	const values = { 'file.file': fileValue(name), 'note.status': textValue(status || '진행중') };
	if (start) values['note.start'] = dateValue(start);
	if (end) values['note.end'] = dateValue(end);
	return makeEntry(name, values);
}

async function mountTimeline(entries, stored, options) {
	const opts = options || {};
	const made = makeApp('visible', null, opts.types || TL_TYPES);
	const exported = require(BUNDLE);
	const PluginClass = exported.default || exported;
	const plugin = new PluginClass(made.app, { id: 'bases-plus' });
	await plugin.onload();

	const registration = plugin.basesViews.find((item) => item.id === 'bases-plus-timeline').registration;
	const containerEl = new FakeEl('div', 'bases-view');
	containerEl.addClass('is-loading');
	const properties = opts.properties || TL_PROPS;
	const config = makeConfig({ stored: Object.assign({ startDate: 'note.start', endDate: 'note.end' }, stored) });

	const view = registration.factory({ app: made.app }, containerEl);
	view.config = config;
	if (opts.groupBy) config.groupBy = opts.groupBy;
	view.allProperties = properties;
	view.data = new BasesQueryResult(entries, properties, (opts.data || {}).groupedData);
	view.onDataUpdated();

	return Object.assign({ plugin, view, containerEl, config, registration, properties }, made);
}

const tlTracks = (containerEl) => containerEl.findAll('bases-plus-tl-track');
const tlBars = (containerEl) => containerEl.findAll('bases-plus-tl-bar');
const px = (el, name) => Math.round(parseFloat(el.style[name] || '0'));
const lastTierSeg = (containerEl) =>
	containerEl.findAll('bases-plus-tl-tier').filter((el) => el.hasClass('is-last'))[0].find('bases-plus-tl-seg');

async function timelineTests() {
	console.log('\n[37] 타임라인 — 등록·골격·옵션');
	resetStubs();
	{
		const { plugin, view, containerEl, registration } = await mountTimeline([
			tlEntry('Note A', '2026-08-10', '2026-08-12'),
			tlEntry('Note B', '2026-08-14', '2026-08-14'),
		]);

		check('registerBasesView 가 bases-plus-timeline 로 불린다', !!plugin.basesViews.find((v) => v.id === 'bases-plus-timeline'));
		check('is-loading 이 벗겨진다', !containerEl.hasClass('is-loading'));
		check('가로·세로 스크롤 주체가 하나다', !!containerEl.find('bases-plus-timeline'));
		check('머리에 코너와 축이 선다', !!containerEl.find('bases-plus-tl-corner') && !!containerEl.find('bases-plus-tl-axis'));
		check('열 헤더가 코너 바닥 줄에 들어간다', containerEl.find('bases-plus-th').parent.hasClass('bases-plus-tl-corner-cols'));
		check('행마다 왼쪽 판과 트랙이 한 쌍이다', containerEl.findAll('bases-plus-tl-label').length === containerEl.findAll('bases-plus-tl-track').length);
		check('셀은 왼쪽 판 안에 들어간다', containerEl.find('bases-plus-cell').parent.hasClass('bases-plus-tl-label'));
		check('판 경계 손잡이가 코너에 있다', containerEl.find('bases-plus-tl-divider').parent.hasClass('bases-plus-tl-corner'));

		const options = registration.options(makeConfig());
		check(
			'옵션 순서가 명세 H 그대로다',
			options.map((o) => o.key).join(',') ===
				'startDate,endDate,openMode,rowLimit,pageSize,groupSize,manualOrderEnabled,groupOrderEnabled,colorBy,barLabel',
			options.map((o) => o.key).join(',')
		);
		check('날짜 속성 둘이 맨 위다', options[0].type === 'property' && options[1].type === 'property');
		view.unload();
	}

	console.log('\n[38] 시작 날짜 속성은 화면이 성립하는 조건이다');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10')], { startDate: '', endDate: '' });
		const noticeEl = containerEl.find('bases-plus-notice');

		check('둘 다 비면 안내 띠가 뜬다', !noticeEl.hidden && noticeEl.text === 'Choose a start date property to draw the timeline.', noticeEl.text);
		check('막대는 그리지 않는다', tlBars(containerEl).every((el) => el.hidden));
		view.unload();
	}

	console.log('\n[39] 축 — 층 구성과 눈금');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const tiers = containerEl.findAll('bases-plus-tl-tier').filter((el) => !el.hidden);

		check('일 배율은 년·월·일 3층이다', tiers.length === 3, String(tiers.length));
		check('맨 아래 층만 is-last 다', tiers.filter((el) => el.hasClass('is-last')).length === 1);
		check('맨 아래 층 칸 폭이 32px 이다', px(tiers[2].find('bases-plus-tl-seg'), 'width') === UNIT_PX);
		check('위 층은 아래 칸을 묶어 넓다', px(tiers[1].find('bases-plus-tl-seg'), 'width') > UNIT_PX);
		check('오늘 칸 글자가 축에서 올라간다', containerEl.findAll('bases-plus-tl-seg-label').some((el) => el.hasClass('is-today')));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')], { timelineUnit: 'year' });
		const tiers = containerEl.findAll('bases-plus-tl-tier').filter((el) => !el.hidden);

		check('년 배율은 1층이다', tiers.length === 1, String(tiers.length));
		check('년 배율 눈금은 96px 이다', px(tiers[0].find('bases-plus-tl-seg'), 'width') === 96);
		view.unload();
	}

	console.log('\n[40] 막대 — 기간·점 항목·빈 날짜');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([
			tlEntry('세 칸', '2026-08-10', '2026-08-12'),
			tlEntry('점 항목', '2026-08-14'),
			tlEntry('날짜 없음', null, null),
		]);
		const bars = tlBars(containerEl);
		const points = containerEl.findAll('bases-plus-tl-point');

		check('기간 막대 폭이 (일수 + 1) × 눈금이다', px(bars[0], 'width') === UNIT_PX * 3, bars[0].style.width);
		check('시작만 있으면 다이아몬드다', bars[1].hidden && !points[1].hidden);
		check('기간 항목은 다이아몬드를 안 쓴다', points[0].hidden && !bars[0].hidden);
		check('날짜가 없으면 트랙이 빈다', bars[2].hidden && points[2].hidden);
		check('막대 하나가 손잡이 둘을 갖는다', bars[0].findAll('bases-plus-tl-bar-handle').length === 2);
		view.unload();
	}

	console.log('\n[41] 라벨 정박 — 보이는 구간 왼쪽 + 8px (확정 7)');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('아주 긴 항목 이름이라 막대를 넘친다', '2026-08-10', '2026-08-11')]);
		const scrollEl = containerEl.find('bases-plus-timeline');
		const barEl = tlBars(containerEl)[0];
		const labelEls = containerEl.findAll('bases-plus-tl-bar-label');

		check('라벨 요소는 행마다 1개다', labelEls.length === containerEl.findAll('bases-plus-tl-track').length);
		check('라벨이 막대 왼쪽 + 8px 에 선다', px(labelEls[0], 'left') === px(barEl, 'left') + 8, labelEls[0].style.left);

		// 가로로 스크롤해 막대 왼쪽이 판 밑으로 들어간 상태 — 이름은 **보이는 구간** 왼쪽에서 다시 시작한다.
		const barLeft = px(barEl, 'left');
		scrollEl.scrollLeft = barLeft + 40;
		scrollEl.clientWidth = 900;
		scrollEl.dispatch('scroll');
		check('스크롤하면 보이는 구간 왼쪽으로 붙는다', px(labelEls[0], 'left') === barLeft + 40 + 8, labelEls[0].style.left);

		// 막대가 통째로 화면 밖 — 이름도 함께 사라진다.
		scrollEl.scrollLeft = barLeft + 5000;
		scrollEl.dispatch('scroll');
		check('막대가 화면 밖이면 이름이 없다', labelEls[0].hidden);
		view.unload();
	}

	console.log('\n[42] 오늘 — 칸 배경 틴트 (트랙 배경 · 3차 4·6번 이후)');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const scrollEl = containerEl.find('bases-plus-timeline');

		// 오늘은 이제 **트랙의 배경**이다 — 자리만 변수로 알려 주고 그리는 것은 CSS 다.
		check('오늘 칸 자리를 변수로 알린다', /^-?\d+px$/.test(String(scrollEl.style['--bases-plus-tl-today-left'])), String(scrollEl.style['--bases-plus-tl-today-left']));
		// 행 전체를 덮는 요소는 없어졌다 — 그룹 헤딩 줄을 가로지를 수 있는 통로 자체를 없앴다.
		check('행을 가로지르는 틴트 요소가 없다', containerEl.find('bases-plus-tl-today') === null);
		view.unload();
	}

	console.log('\n[43] 끝단 드래그로 날짜 고치기');
	resetStubs();
	{
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const handleEl = containerEl.findAll('bases-plus-tl-bar-handle').filter((el) => el.hasClass('mod-end'))[0];

		handleEl.dispatch('pointerdown', { pointerId: 1, clientX: 100 });
		handleEl.dispatch('pointermove', { pointerId: 1, clientX: 100 + UNIT_PX * 2 });
		handleEl.dispatch('pointerup', { pointerId: 1, clientX: 100 + UNIT_PX * 2 });
		await wait();

		check('끝단을 두 칸 끌면 종료가 이틀 뒤다', frontmatter['notes/Note A.md'].end === '2026-08-14', JSON.stringify(frontmatter));
		check('시작은 건드리지 않는다', frontmatter['notes/Note A.md'].start === '2026-08-10');
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const handleEl = containerEl.findAll('bases-plus-tl-bar-handle').filter((el) => el.hasClass('mod-end'))[0];

		handleEl.dispatch('pointerdown', { pointerId: 2, clientX: 200 });
		handleEl.dispatch('pointermove', { pointerId: 2, clientX: 200 - UNIT_PX * 9 });
		handleEl.dispatch('pointerup', { pointerId: 2, clientX: 200 - UNIT_PX * 9 });
		await wait();

		check('끝을 시작보다 앞으로 끌면 시작에서 멈춘다', frontmatter['notes/Note A.md'].end === '2026-08-10', JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const barEl = tlBars(containerEl)[0];

		barEl.dispatch('pointerdown', { pointerId: 3, clientX: 100 });
		barEl.dispatch('pointermove', { pointerId: 3, clientX: 100 + UNIT_PX * 2 });
		barEl.dispatch('pointerup', { pointerId: 3, clientX: 100 + UNIT_PX * 2 });
		await wait();

		check('가운데를 끌면 기간을 유지한 채 통째로 이동한다', frontmatter['notes/Note A.md'].start === '2026-08-12' && frontmatter['notes/Note A.md'].end === '2026-08-14', JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const barEl = tlBars(containerEl)[0];

		barEl.dispatch('pointerdown', { pointerId: 4, clientX: 100 });
		barEl.dispatch('pointermove', { pointerId: 4, clientX: 102 });
		barEl.dispatch('pointerup', { pointerId: 4, clientX: 102 });
		await wait();

		check('3px 미만이면 클릭이라 노트를 연다', Modal.instances.length === 1);
		check('클릭은 날짜를 쓰지 않는다', frontmatter['notes/Note A.md'] === undefined);
		if (Modal.instances[0]) Modal.instances[0].close();
		view.unload();
	}

	console.log('\n[44] 판 경계 폭 조절');
	resetStubs();
	{
		const { view, containerEl, config } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const dividerEl = containerEl.find('bases-plus-tl-divider');

		dividerEl.dispatch('pointerdown', { pointerId: 5, clientX: 320 });
		dividerEl.dispatch('pointerup', { pointerId: 5, clientX: 320 });
		check('끌지 않고 놓으면 저장하지 않는다', config.stored.timelineLabelWidth === undefined);

		dividerEl.dispatch('pointerdown', { pointerId: 6, clientX: 320 });
		dividerEl.dispatch('pointermove', { pointerId: 6, clientX: 420 });
		check('끄는 동안에는 저장하지 않는다', config.stored.timelineLabelWidth === undefined);
		dividerEl.dispatch('pointerup', { pointerId: 6, clientX: 420 });
		check('놓을 때 한 번 저장한다', config.stored.timelineLabelWidth === 420, String(config.stored.timelineLabelWidth));

		dividerEl.dispatch('pointerdown', { pointerId: 7, clientX: 420 });
		dividerEl.dispatch('pointermove', { pointerId: 7, clientX: 0 });
		dividerEl.dispatch('pointerup', { pointerId: 7, clientX: 0 });
		check('하한 아래로는 안 줄어든다', config.stored.timelineLabelWidth === 40, String(config.stored.timelineLabelWidth));
		view.unload();
	}

	console.log('\n[45] 줌 — 배율 전환');
	resetStubs();
	{
		const { view, containerEl, config } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const tools = containerEl.findAll('bases-plus-tl-tool');
		const zoomOut = tools[0];
		const zoomIn = tools[1];

		check('푸터에 줌·오늘 컨트롤이 선다', tools.length >= 4);
		check('지금 배율을 글자로 알린다', containerEl.find('bases-plus-tl-unit').text === 'Day');

		// 주와 달 사이가 3배 넘게 벌어져 중간이 없던 것이 1차 15번이다 — 같은 단위에 넓은 단계를 하나씩 더 뒀다.
		zoomOut.dispatch('click');
		check('한 단계 줌 아웃하면 넓은 주 배율이다', config.stored.timelineUnit === 'week-wide', String(config.stored.timelineUnit));
		check('배율 글자가 넓은 단계임을 알린다', containerEl.find('bases-plus-tl-unit').text === 'Week +');
		check('넓은 주 눈금은 64px 이다', px(lastTierSeg(containerEl), 'width') === 64);

		zoomOut.dispatch('click');
		check('한 단계 더 줄이면 기본 주 배율이다', config.stored.timelineUnit === 'week');
		check('기본 주 눈금은 명세 폭 40px 그대로다', px(lastTierSeg(containerEl), 'width') === 40);

		zoomIn.dispatch('click');
		zoomIn.dispatch('click');
		check('줌 인하면 일 배율로 돌아온다', config.stored.timelineUnit === 'day');

		// 단계 사다리가 하루당 px 기준으로 단조 감소해야 확대·축소가 뒤집히지 않는다.
		const ladder = ['day', 'week-wide', 'week', 'month-wide', 'month', 'quarter', 'year'];
		const seen = [];
		for (const id of ladder) {
			view.config.set('timelineUnit', id);
			view.onDataUpdated();
			seen.push(px(lastTierSeg(containerEl), 'width'));
		}
		check('줌 단계가 7개다 (주·달에 하나씩 더)', seen.length === 7);
		check('단계 폭이 명세값을 지킨다', seen.join(',') === '32,64,40,96,56,72,96', seen.join(','));
		view.unload();
	}

	resetStubs();
	{
		// 주 배율에서 `8월 3일` 같은 라벨이 40px 칸을 넘어 겹쳤다(마스터 1차 15번).
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')], { timelineUnit: 'week' });
		const labels = containerEl.findAll('bases-plus-tl-tier').filter((el) => el.hasClass('is-last'))[0].findAll('bases-plus-tl-seg-label');
		const filled = labels.filter((el) => el.text !== '');

		check('좁은 칸에서는 글자를 솎아 낸다', filled.length < labels.length, `${filled.length}/${labels.length}`);
		check('솎아 내도 칸(격자)은 그대로다', labels.length >= 14);
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')], { timelineUnit: 'week-wide' });
		const labels = containerEl.findAll('bases-plus-tl-tier').filter((el) => el.hasClass('is-last'))[0].findAll('bases-plus-tl-seg-label');

		check('넓은 주 배율에서는 전부 글자가 선다', labels.every((el) => el.text !== ''));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl, config } = await mountTimeline([tlEntry('Note A', '2026-08-10')], { timelineUnit: 'year' });
		containerEl.findAll('bases-plus-tl-tool')[0].dispatch('click');
		check('가장 성긴 배율에서는 더 줌 아웃되지 않는다', config.stored.timelineUnit === 'year');
		view.unload();
	}

	console.log('\n[46] 상태·태그별 막대 색 (확정 8)');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const paletteEl = containerEl.findAll('bases-plus-tl-tool')[3];

		check('Color by 가 비면 색 버튼이 없다', paletteEl.hidden);
		check('색을 안 켠 막대는 강조색 하나다', !tlBars(containerEl)[0].hasClass('is-tinted'));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl } = await mountTimeline(
			[
				tlEntry('Note A', '2026-08-10', '2026-08-12', '진행중'),
				tlEntry('Note B', '2026-08-13', '2026-08-14', '완료'),
			],
			{ colorBy: 'note.status' }
		);
		const bars = tlBars(containerEl);
		const paletteEl = containerEl.findAll('bases-plus-tl-tool')[3];

		check('Color by 를 켜면 색 버튼이 뜬다', !paletteEl.hidden);
		check('색을 켠 막대는 채움이 바뀐다', bars[0].hasClass('is-tinted') && bars[1].hasClass('is-tinted'));
		check('값마다 팔레트 자리가 다르다', bars[0].style['--bases-plus-tl-color'] !== bars[1].style['--bases-plus-tl-color'], `${bars[0].style['--bases-plus-tl-color']} / ${bars[1].style['--bases-plus-tl-color']}`);
		check('색표는 그래프 뷰와 같은 변수를 쓴다', String(bars[0].style['--bases-plus-tl-color']).indexOf('--bases-plus-series-') !== -1);

		paletteEl.dispatch('click');
		const modal = Modal.instances[Modal.instances.length - 1];
		check('색 대화상자가 열린다', !!modal && modal.isOpen);
		check('값마다 8색 스와치가 선다', modal.contentEl.findAll('bases-plus-bar-color-item')[0].findAll('bases-plus-bar-color-swatch').length === 8);
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl } = await mountTimeline(
			[tlEntry('Note A', '2026-08-10', '2026-08-12', '진행중')],
			{ colorBy: 'note.status', barColors: { 진행중: 5 } }
		);

		check('저장된 매핑이 자동 배정을 이긴다', tlBars(containerEl)[0].style['--bases-plus-tl-color'] === 'var(--bases-plus-series-5)', String(tlBars(containerEl)[0].style['--bases-plus-tl-color']));
		view.unload();
	}

	console.log('\n[48] 항목 추가');
	resetStubs();
	{
		const entries = [tlEntry('Note A', '2026-08-10', '2026-08-12', '진행중')];
		const mounted = await mountTimeline(entries, {}, {
			groupBy: { property: 'note.status', direction: 'ASC' },
			data: { groupedData: [{ key: textValue('진행중'), hasKey: () => true, entries }] },
		});
		const addEl = mounted.containerEl.find('bases-plus-group-add');

		check('그룹 헤딩 오른쪽 끝에 + 가 있다', !!addEl);
		check('그룹이 있으면 푸터 + 는 감춘다', mounted.containerEl.findAll('bases-plus-tl-tool')[4].hidden);

		addEl.dispatch('click');
		await wait();
		check('그 그룹의 값을 심어 만든다', BasesView.created.length === 1 && BasesView.created[0].frontmatter.status === '진행중', JSON.stringify(BasesView.created));
		mounted.view.unload();
	}

	resetStubs();
	{
		const mounted = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		check('그룹이 없으면 푸터 왼쪽 끝에 하나 둔다', !mounted.containerEl.findAll('bases-plus-tl-tool')[4].hidden);

		mounted.containerEl.findAll('bases-plus-tl-tool')[4].dispatch('click');
		await wait();
		check('그룹이 없으면 값을 심지 않는다', BasesView.created.length === 1 && Object.keys(BasesView.created[0].frontmatter).length === 0);
		mounted.view.unload();
	}

	console.log('\n[49] 계승 — 표의 기능이 그대로 산다');
	resetStubs();
	{
		const entries = [
			tlEntry('Note A', '2026-08-10', '2026-08-12'),
			tlEntry('Note B', '2026-08-13', '2026-08-14'),
			tlEntry('Note C', '2026-08-15', '2026-08-16'),
		];
		const { view, containerEl } = await mountTimeline(entries, { rowLimit: 'pages', pageSize: '2' });

		check('페이징이 그대로 선다', visibleRowEls(containerEl).length === 2);
		check('푸터 페이저가 있다', pagerTextOf(containerEl.find('bases-plus-footer-bar')) === '1 / 2');
		check('푸터는 페이저가 없어도 붙어 있다 (줌 컨트롤 때문)', !!containerEl.find('bases-plus-tl-tools'));
		view.unload();
	}

	resetStubs();
	{
		const entries = [tlEntry('Note A', '2026-08-10', '2026-08-12'), tlEntry('Note B', '2026-08-13', '2026-08-14')];
		const { view, containerEl } = await mountTimeline(entries, { manualOrderEnabled: true });

		check('수동 순서 손잡이가 그대로 있다', containerEl.findAll('bases-plus-order-handle').length >= 2);
		// 자리는 CSS `order` 가 잡는다 — DOM 에서는 표와 같이 **내용 뒤**에 붙는다(C2 함정과 같은 규칙).
		const rowChildren = containerEl.find('bases-plus-row').children;
		check('손잡이는 DOM 상 내용 뒤에 붙는다', rowChildren[rowChildren.length - 1].hasClass('bases-plus-order-handle'));
		view.unload();
	}

	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		clickName(containerEl);
		await wait();
		check('이름 링크로 여는 경로가 그대로다', Modal.instances.length === 1);
		if (Modal.instances[0]) Modal.instances[0].close();
		view.unload();
	}

	console.log('\n[52] 실기동 1차 요청 — 빈 트랙 클릭·점 항목 드래그·막대 글자');
	resetStubs();
	{
		// 날짜가 없는 행의 빈 트랙을 누르면 그 자리 날짜로 시작이 잡힌다(요청 1번).
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('빈 행', null, null)]);
		const trackEl = tlTracks(containerEl)[0];

		trackEl.dispatch('click', { button: 0, clientX: 32 * 3 });
		await wait();
		const written = frontmatter['notes/빈 행.md'];
		check('빈 트랙을 누르면 시작이 잡힌다', !!written && /^\d{4}-\d{2}-\d{2}$/.test(written.start), JSON.stringify(written));
		check('말하지 않은 종료는 만들지 않는다', !!written && written.end === undefined);
		view.unload();
	}

	resetStubs();
	{
		// 막대가 있는 트랙에서는 막대가 클릭을 받는다 — 빈자리 클릭이 날짜를 덮어쓰지 않는다.
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		tlTracks(containerEl)[0].dispatch('click', { button: 0, clientX: 400 });
		await wait();
		check('막대가 있는 트랙은 클릭으로 날짜를 덮지 않는다', frontmatter['notes/Note A.md'] === undefined);
		view.unload();
	}

	resetStubs();
	{
		// 시작=종료(다이아몬드)도 끝을 끌어 기간으로 늘릴 수 있어야 한다(요청 2번).
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('점', '2026-08-10', '2026-08-10')]);
		const handleEl = containerEl.findAll('bases-plus-tl-point-handle').filter((el) => el.hasClass('mod-end'))[0];

		check('점 항목에 끝단 손잡이가 있다', !!handleEl);
		handleEl.dispatch('pointerdown', { pointerId: 11, clientX: 100 });
		handleEl.dispatch('pointermove', { pointerId: 11, clientX: 100 + UNIT_PX * 3 });
		handleEl.dispatch('pointerup', { pointerId: 11, clientX: 100 + UNIT_PX * 3 });
		await wait();
		check('점의 끝을 끌면 기간이 된다', frontmatter['notes/점.md'].end === '2026-08-13', JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		// 시작만 있는 항목을 통째로 옮겼다고 종료를 새로 만들지는 않는다.
		const { view, containerEl, frontmatter } = await mountTimeline([tlEntry('시작만', '2026-08-10', null)]);
		const pointEl = containerEl.findAll('bases-plus-tl-point')[0];

		pointEl.dispatch('pointerdown', { pointerId: 12, clientX: 100 });
		pointEl.dispatch('pointermove', { pointerId: 12, clientX: 100 + UNIT_PX * 2 });
		pointEl.dispatch('pointerup', { pointerId: 12, clientX: 100 + UNIT_PX * 2 });
		await wait();
		check('점을 옮기면 시작만 바뀐다', frontmatter['notes/시작만.md'].start === '2026-08-12');
		check('없던 종료가 생기지 않는다', frontmatter['notes/시작만.md'].end === undefined, JSON.stringify(frontmatter));
		view.unload();
	}

	resetStubs();
	{
		// 막대 글자를 파일 이름 대신 다른 속성으로 — 이제 **여러 개**를 받는다(3차 요청).
		const label = (containerEl) => containerEl.find('bases-plus-tl-bar-label').text;
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12', '진행중')], {
			barLabel: ['note.status'],
		});
		check('Bar label 을 정하면 그 속성 값이 막대 글자다', label(containerEl) === '진행중');

		view.config.set('barLabel', ['note.status', 'note.start']);
		view.onDataUpdated();
		check('여러 속성을 이어 붙인다', label(containerEl) === '진행중 · 2026-08-10', label(containerEl));

		view.config.set('barLabel', ['note.없는속성', 'note.status']);
		view.onDataUpdated();
		check('빈 값은 건너뛰고 구분자도 안 남긴다', label(containerEl) === '진행중', label(containerEl));

		view.config.set('barLabel', null);
		view.onDataUpdated();
		check('비우면 파일 이름으로 돌아온다', label(containerEl) === 'Note A');

		view.config.set('barLabel', ['note.없는속성']);
		view.onDataUpdated();
		check('전부 비면 파일 이름으로 떨어진다', label(containerEl) === 'Note A');

		// 예전 단일 저장값(문자열)도 그대로 읽는다 — `property` 옵션으로 저장된 `.base` 가 조용히 안 꺼지게.
		view.config.set('barLabel', 'note.status');
		view.onDataUpdated();
		check('예전 문자열 저장값도 읽는다', label(containerEl) === '진행중', label(containerEl));
		view.unload();
	}

	resetStubs();
	{
		const { view, registration } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const option = registration.options(makeConfig()).find((o) => o.key === 'barLabel');
		check('Bar label 은 여러 줄을 받는 종류다', option.type === 'multitext', option.type);
		view.unload();
	}

	console.log('\n[53] 축이 화면을 채운다 (1차 요청 3번 — base 직접 열기의 빈 띠)');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const scrollEl = containerEl.find('bases-plus-timeline');
		const narrow = Math.round(parseFloat(scrollEl.style['--bases-plus-tl-axis-width']));

		scrollEl.clientWidth = 1600;
		view.onDataUpdated();
		const wide = Math.round(parseFloat(scrollEl.style['--bases-plus-tl-axis-width']));

		check('화면이 넓어지면 축도 그만큼 길어진다', wide >= 1600 - 320, String(wide));
		check('데이터만으로 잡던 폭보다 길다', wide > narrow, `${narrow} -> ${wide}`);
		view.unload();
	}

	console.log('\n[54] 2차 피드백 — 줌 메뉴·헤딩 정박');
	resetStubs();
	{
		// 배율 이름을 눌러 단계를 바로 고른다(2차 2번).
		const { view, containerEl, config } = await mountTimeline([tlEntry('Note A', '2026-08-10', '2026-08-12')]);
		const unitEl = containerEl.find('bases-plus-tl-unit');

		unitEl.dispatch('click', { button: 0, clientX: 10, clientY: 10 });
		const menu = Menu.instances[Menu.instances.length - 1];
		check('배율 이름을 누르면 메뉴가 뜬다', !!menu && menu.shown);
		check('사다리 7단이 그대로 항목이다', menu.items.map((i) => i.title).join(',') === 'Day,Week +,Week,Month +,Month,Quarter,Year', menu.items.map((i) => i.title).join(','));
		check('지금 단계에 체크가 있다', menu.items[0].checked === true && menu.items[3].checked === false);

		menu.items[4].click();
		check('고른 단계로 바로 뛴다', config.stored.timelineUnit === 'month', String(config.stored.timelineUnit));
		view.unload();
	}

	resetStubs();
	{
		// 개수와 `+` 가 한 상자에 묶여 오른쪽에 정박한다(2차 8번).
		const entries = [tlEntry('Note A', '2026-08-10', '2026-08-12', '진행중')];
		const mounted = await mountTimeline(entries, {}, {
			groupBy: { property: 'note.status', direction: 'ASC' },
			data: { groupedData: [{ key: textValue('진행중'), hasKey: () => true, entries }] },
		});
		const tailEl = mounted.containerEl.find('bases-plus-tl-group-tail');

		check('개수와 + 가 한 상자에 있다', !!tailEl && !!tailEl.find('bases-plus-group-count') && !!tailEl.find('bases-plus-group-add'));
		check('그 상자가 헤딩 직속이다', tailEl.parent.hasClass('bases-plus-group-heading'));
		mounted.view.unload();
	}

	console.log('\n[57] 회귀 — 그룹이 사라진다');
	resetStubs();
	{
		const entries = [
			tlEntry('부모', '2026-08-10', '2026-08-12', '진행중'),
			tlEntry('자식', '2026-08-11', '2026-08-11', '진행중'),
			tlEntry('딴것', '2026-08-13', '2026-08-14', '완료'),
		];
		// 캡처 당시 조건에서 그룹이 통째로 사라졌다 — 원인이던 경로는 제거됐고 이 테스트가 그 자리를 지킨다.
		const mounted = await mountTimeline(entries, {}, {
			groupBy: { property: 'note.status', direction: 'ASC' },
			data: {
				groupedData: [
					{ key: textValue('진행중'), hasKey: () => true, entries: [entries[0], entries[1]] },
					{ key: textValue('완료'), hasKey: () => true, entries: [entries[2]] },
				],
			},
		});
		const headings = () => headingEls(mounted.containerEl).length;
		check('그룹 헤딩이 계획대로 선다', headings() === 2, String(headings()));
		for (let i = 0; i < 4; i++) mounted.view.onDataUpdated();
		check('되풀이 갱신에도 그룹이 유지된다', headings() === 2, String(headings()));
		mounted.view.unload();
	}

	resetStubs();
	{
		/*
		 * 행과 트랙의 짝 — **보이는 행마다 트랙이 정확히 하나**여야 한다. 어긋나면 몇 행만 격자·막대가
		 * 통째로 빠진 화면이 된다(3차 회귀 2번의 증상). 그룹·연관·페이지를 겹쳐 놓고 되풀이해 갱신한다.
		 */
		const entries = Array.from({ length: 9 }, (_, i) =>
			tlEntry(`행 ${i}`, `2026-08-${10 + (i % 5)}`, `2026-08-${12 + (i % 5)}`, i % 3 === 0 ? '진행중' : '대기')
		);
		const mounted = await mountTimeline(entries, {}, {
			groupBy: { property: 'note.status', direction: 'ASC' },
			data: {
				groupedData: [
					{ key: textValue('진행중'), hasKey: () => true, entries: entries.filter((_, i) => i % 3 === 0) },
					{ key: textValue('대기'), hasKey: () => true, entries: entries.filter((_, i) => i % 3 !== 0) },
				],
			},
		});
		for (let i = 0; i < 4; i++) mounted.view.onDataUpdated();

		const rows = visibleRowEls(mounted.containerEl);
		const tracks = rows.map((el) => el.findAll('bases-plus-tl-track').length);
		check('보이는 행마다 트랙이 정확히 하나다', tracks.every((n) => n === 1), tracks.join(','));
		check('그룹 헤딩에는 트랙이 없다', headingEls(mounted.containerEl).every((el) => el.findAll('bases-plus-tl-track').length === 0));
		check('되풀이 갱신에도 그룹이 유지된다', headingEls(mounted.containerEl).length === 2, String(headingEls(mounted.containerEl).length));
		mounted.view.unload();
	}

	console.log('\n[50] 요소 재사용 — 갱신마다 다시 만들지 않는다 (성2)');
	resetStubs();
	{
		const { view, containerEl } = await mountTimeline([
			tlEntry('Note A', '2026-08-10', '2026-08-12'),
			tlEntry('Note B', '2026-08-13', '2026-08-14'),
		]);
		const firstTrack = tlTracks(containerEl)[0];
		const firstBar = tlBars(containerEl)[0];
		const before = containerEl.countNodes();
		const listeners = firstBar.listeners.length;

		for (let i = 0; i < 5; i++) view.onDataUpdated();

		check('트랙 요소를 재사용한다', tlTracks(containerEl)[0] === firstTrack);
		check('막대 요소를 재사용한다', tlBars(containerEl)[0] === firstBar);
		check('갱신해도 노드가 늘지 않는다', containerEl.countNodes() === before, `${before} -> ${containerEl.countNodes()}`);
		check('갱신해도 막대 리스너가 누적되지 않는다', firstBar.listeners.length === listeners);

		// 축은 층마다 칸을 다시 만들지만 층 요소 자체는 풀에서 재사용한다.
		const tierCount = containerEl.findAll('bases-plus-tl-tier').length;
		view.config.set('timelineUnit', 'year');
		view.onDataUpdated();
		check('배율을 바꿔도 층 요소를 재사용한다', containerEl.findAll('bases-plus-tl-tier').length === tierCount);
		check('안 쓰는 층은 감춘다', containerEl.findAll('bases-plus-tl-tier').filter((el) => el.hidden).length === tierCount - 1);
		view.unload();
	}
}

main().catch((error) => { console.error(error); process.exit(1); });

// ── 달력 (3단계) ────────────────────────────────────────────────────────────────────
/** 달력도 왼쪽 표가 없을 뿐 같은 값 모양을 쓴다 — 날짜는 값에서 읽는 경로를 태운다. */
const CAL_PROPS = ['file.name', 'note.status'];
const CAL_TYPES = { start: 'date', end: 'date', status: 'text', priority: 'number', 완료: 'checkbox' };

function calEntry(name, start, end, status, done) {
	const values = { 'file.file': fileValue(name), 'note.status': textValue(status || '진행중') };
	if (start) values['note.start'] = dateValue(start);
	if (end) values['note.end'] = dateValue(end);
	if (done !== undefined) values['note.완료'] = boolValue(done);
	return makeEntry(name, values);
}

async function mountCalendar(entries, stored, options) {
	const opts = options || {};
	const made = makeApp('visible', null, opts.types || CAL_TYPES);
	const exported = require(BUNDLE);
	const PluginClass = exported.default || exported;
	const plugin = new PluginClass(made.app, { id: 'bases-plus' });
	await plugin.onload();

	const registration = plugin.basesViews.find((item) => item.id === 'bases-plus-calendar').registration;
	const containerEl = new FakeEl('div', 'bases-view');
	containerEl.addClass('is-loading');
	const properties = opts.properties || CAL_PROPS;
	const config = makeConfig({ stored: Object.assign({ startDate: 'note.start', endDate: 'note.end' }, stored) });

	// 쿼리 결과의 파일을 볼트에도 세운다 — 태스크 수집이 실물처럼 캐시·본문을 그 경로로 찾는다.
	for (const entry of entries) made.app.vault.files[entry.file.path] = entry.file;

	const view = registration.factory({ app: made.app }, containerEl);
	view.config = config;
	view.allProperties = properties;
	view.data = new BasesQueryResult(entries, properties);
	view.onDataUpdated();

	return Object.assign({ plugin, view, containerEl, config, registration, properties }, made);
}

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
const isoOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const todayDate = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); };
/** 이번 달 n 일. 오늘과 무관하게 같은 달 안에서 자리를 잡는다 — 달이 바뀌어도 뜻이 유지된다. */
const dayOfMonth = (n) => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), n); };

/**
 * 그리드의 단위는 **주**다 — 칸은 배경만 지고 항목은 주의 자식이라 칸 경계를 가로지른다(1차 16·22번).
 * 그래서 헬퍼도 주에서 출발한다.
 */
const calWeeks = (containerEl) => containerEl.findAll('bases-plus-cal-week').filter((el) => !el.hidden);
const calDayBgs = (weekEl) => weekEl.findAll('bases-plus-cal-day');
const calHeads = (weekEl) => weekEl.findAll('bases-plus-cal-dayhead');
const dayNumOf = (headEl) => Number(headEl.find('bases-plus-cal-daynum').text);
const calSlots = (weekEl) => weekEl.findAll('bases-plus-cal-slot').filter((el) => !el.hidden);
const calMores = (weekEl) => weekEl.findAll('bases-plus-cal-more').filter((el) => !el.hidden);
const calItemEl = (slotEl) => { const el = slotEl.find('bases-plus-cal-item'); return el && !el.hidden ? el : null; };
const calTaskEl = (slotEl) => { const el = slotEl.find('bases-plus-cal-task'); return el && !el.hidden ? el : null; };
/** 슬롯이 잡은 자리 — `grid-column: from+1 / to+2` · `grid-row: lane+2` 를 되읽는다. */
const slotAt = (slotEl) => {
	const column = String(slotEl.style.gridColumn || '');
	const [from, to] = column.split('/').map((part) => Number(part.trim()));
	return { from: from - 1, to: (to || from + 1) - 2, lane: Number(slotEl.style.gridRow) - 2 };
};
/** 이번 달의 그 날짜가 몇 번째 주·몇 번째 칸인지. 달 밖 칸에도 같은 숫자가 있어 표식을 함께 본다. */
const findDay = (containerEl, date) => {
	const weeks = calWeeks(containerEl);
	for (let w = 0; w < weeks.length; w++) {
		const heads = calHeads(weeks[w]);
		for (let c = 0; c < heads.length; c++) {
			if (dayNumOf(heads[c]) === date.getDate() && !heads[c].hasClass('is-outside')) {
				return { week: weeks[w], weekIndex: w, col: c, head: heads[c], bg: calDayBgs(weeks[w])[c] };
			}
		}
	}
	return null;
};
/** 그 칸에 실제로 걸린 항목들(자리를 함께 돌려준다). */
const itemsOn = (containerEl, date) => {
	const at = findDay(containerEl, date);
	if (!at) return [];
	return calSlots(at.week)
		.map((el) => ({ el, itemEl: calItemEl(el), taskEl: calTaskEl(el), ...slotAt(el) }))
		.filter((slot) => slot.from <= at.col && at.col <= slot.to);
};
const moreOn = (containerEl, date) => {
	const at = findDay(containerEl, date);
	if (!at) return null;
	return calMores(at.week).find((el) => Number(el.style.gridColumn) === at.col + 1) || null;
};
const itemTextOf = (slot) => (slot.itemEl ? slot.itemEl.find('bases-plus-cal-item-text').text : null);
/**
 * 레이아웃이 없는 하네스에 **달력의 기하**를 심는다. 드래그는 포인터가 선 칸을 날짜로 되돌리므로
 * (주 경계를 넘는 이동이 그래야 된다) 자리 없이는 실물과 다른 가지를 탄다.
 */
const CAL_WEEK_WIDTH = 700;
const CAL_WEEK_HEIGHT = 90;
const layoutCalendar = (containerEl) => {
	calWeeks(containerEl).forEach((weekEl, index) => {
		weekEl.offsetTop = index * CAL_WEEK_HEIGHT;
		weekEl.offsetHeight = CAL_WEEK_HEIGHT;
		weekEl.offsetWidth = CAL_WEEK_WIDTH;
		calDayBgs(weekEl).forEach((el) => { el.offsetWidth = CAL_WEEK_WIDTH / 7; });
	});
};
/** 그 주·그 칸 한가운데를 가리키는 포인터 좌표. */
const pointAt = (weekIndex, col) => ({
	clientX: (CAL_WEEK_WIDTH / 7) * col + CAL_WEEK_WIDTH / 14,
	clientY: weekIndex * CAL_WEEK_HEIGHT + CAL_WEEK_HEIGHT / 2,
});
/** 그 날짜가 선 주·칸의 포인터 좌표. */
const pointOn = (containerEl, date) => {
	const at = findDay(containerEl, date);
	return pointAt(at.weekIndex, at.col);
};
/**
 * 드래그 제스처. **누르기는 손잡이가, 이동·놓기는 뷰 루트가 받는다** — 실물에서도 캡처를 쥔 요소로
 * 이벤트가 재타깃되기 때문이다. 손잡이에 계속 보내면 실물과 다른 경로를 흉내 내게 된다.
 */
const grabAt = (containerEl, handleEl, date, pointerId) =>
	handleEl.dispatch('pointerdown', Object.assign({ button: 0, pointerId, target: handleEl }, pointOn(containerEl, date)));
const dragTo = (containerEl, date, pointerId) => {
	const rootEl = containerEl.find('bases-plus-view');
	rootEl.dispatch('pointermove', Object.assign({ pointerId, target: rootEl }, pointOn(containerEl, date)));
};
const dropAt = (containerEl, date, pointerId) => {
	const rootEl = containerEl.find('bases-plus-view');
	rootEl.dispatch('pointerup', Object.assign({ pointerId, target: rootEl }, pointOn(containerEl, date)));
};
const taskTextOf = (slot) => (slot.taskEl ? slot.taskEl.find('bases-plus-cal-task-text').text : null);

async function calendarTests() {
	console.log('\n[60] 달력 — 등록·골격·옵션');
	resetStubs();
	{
		const { plugin, view, containerEl, registration } = await mountCalendar([
			calEntry('Note A', isoOf(dayOfMonth(10)), isoOf(dayOfMonth(12))),
		]);

		check('registerBasesView 가 bases-plus-calendar 로 불린다', !!plugin.basesViews.find((v) => v.id === 'bases-plus-calendar'));
		check('is-loading 이 벗겨진다', !containerEl.hasClass('is-loading'));
		check('머리·요일 줄·그리드가 선다',
			!!containerEl.find('bases-plus-cal-head') && !!containerEl.find('bases-plus-cal-weekdays') && !!containerEl.find('bases-plus-cal-grid'));
		check('요일 머리가 7칸이다', containerEl.findAll('bases-plus-cal-weekday').length === 7);
		check('주마다 배경 칸이 7개다', calWeeks(containerEl).every((el) => calDayBgs(el).length === 7));
		check('주마다 날짜 줄이 7개다', calWeeks(containerEl).every((el) => calHeads(el).length === 7));
		check('배경 칸이 줄 전체를 덮는다', calDayBgs(calWeeks(containerEl)[0])[0].style.gridRow === '1 / -1');
		check('이동 버튼이 표 페이저 버튼 어휘다', containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button').length === 2);
		check('오늘 버튼이 확정분 문구 버튼 어휘다', !!containerEl.find('bases-plus-cal-today').hasClass('bases-plus-group-more'));
		check('월·주 세그먼트가 둘이다', containerEl.findAll('bases-plus-cal-mode').length === 2);
		check('그룹·페이징 요소가 없다',
			containerEl.findAll('bases-plus-group-heading').length === 0 && containerEl.findAll('bases-plus-footer').length === 0);

		const options = registration.options(makeConfig());
		check(
			'옵션 순서가 명세 F + 1·2차 요청 그대로다',
			options.map((o) => o.key).join(',') ===
				'startDate,endDate,calendarView,itemsPerDay,weekStart,wrapItems,showTasks,colorBy,propertyDisplay,showEmptyProperties,checkboxProperty,checkboxWhenMissing,listProperty,openMode',
			options.map((o) => o.key).join(',')
		);
		check('날짜 속성 둘이 맨 위다', options[0].type === 'property' && options[1].type === 'property');
		check('날짜가 될 수 없는 속성은 뺀다', options[0].filter('note.priority') === false && options[0].filter('note.start') === true);
		check('등록 위젯이 없는 파일 날짜는 남긴다', options[0].filter('file.ctime') === true);
		const optionOf = (key) => options.find((o) => o.key === key);
		check('체크박스 속성은 체크박스 타입만 받는다',
			optionOf('checkboxProperty').filter('note.완료') === true && optionOf('checkboxProperty').filter('note.status') === false);
		// 색 규칙은 타임라인과 **같은 키**를 쓴다 — 한 base 에서 같은 값이 두 색이면 안 된다(2차 8번).
		check('Color by 가 타임라인과 같은 키다', !!optionOf('colorBy'));
		check('속성 표시 방식이 두 선택지다',
			JSON.stringify(optionOf('propertyDisplay').options) === JSON.stringify({ names: 'Name and value', values: 'Values only' }));
		// 두 표시 방식 모두에서 살아야 한다 — 감추면 값만 보기에서 안 먹는 것으로 보인다(3차 6번).
		check('빈 값 옵션은 어느 방식에서도 감춰지지 않는다', optionOf('showEmptyProperties').shouldHide === undefined);
		check('체크박스 하위 옵션은 속성을 안 고르면 감춰진다', optionOf('checkboxWhenMissing').shouldHide.call(null) === true);
		check('Items per day 기본값이 3 이다', options[3].placeholder === '3');
		view.unload();
	}

	console.log('\n[61] 시작 날짜 속성은 화면이 성립하는 조건이다');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))], { startDate: '', endDate: '' });
		const notice = containerEl.find('bases-plus-notice');

		check('안내 띠가 뜬다', !notice.hidden && notice.text === 'Choose a start date property to draw the calendar.');
		check('그리드는 그대로 선다', calWeeks(containerEl).length >= 4);
		check('항목은 하나도 안 그려진다', calWeeks(containerEl).every((el) => calSlots(el).length === 0));
		view.unload();
	}

	console.log('\n[62] 날짜 칸 — 오늘·주말·이번 달 밖 (명세 B1)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))]);
		const weeks = calWeeks(containerEl);
		const bgs = weeks.flatMap(calDayBgs);
		const heads = weeks.flatMap(calHeads);
		const todays = bgs.filter((el) => el.hasClass('is-today'));

		check('오늘 칸이 정확히 하나다', todays.length === 1, String(todays.length));
		check('오늘 표식이 날짜 줄에도 붙는다', heads.filter((el) => el.hasClass('is-today')).length === 1);
		check('주말 칸이 주 수의 두 배다', bgs.filter((el) => el.hasClass('is-weekend')).length === weeks.length * 2);
		check('첫 칸은 일요일에서 시작한다(로케일 파생 en)', calDayBgs(weeks[0])[0].hasClass('is-weekend'));
		check('이번 달 밖 칸은 숫자도 흐리다',
			heads.filter((el) => el.hasClass('is-outside')).length === bgs.filter((el) => el.hasClass('is-outside')).length);
		view.unload();
	}

	console.log('\n[63] 첫 요일 옵션 — 로케일 파생값을 덮는다 (명세 B3)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))], { weekStart: '1' });
		const bgs = calDayBgs(calWeeks(containerEl)[0]);

		check('월요일 시작이면 첫 칸이 주말이 아니다', !bgs[0].hasClass('is-weekend'));
		check('마지막 칸은 일요일이다', bgs[6].hasClass('is-weekend'));
		view.unload();
	}

	console.log('\n[64] 항목 막대 — 한 주에서 한 요소로 걸친다 (1차 16번 · 명세 C1)');
	resetStubs();
	{
		// 9일짜리라 반드시 줄을 넘는다 — 어느 요일에서 시작하든 두 줄 이상에 걸친다.
		const { view, containerEl } = await mountCalendar([
			calEntry('긴 일', isoOf(dayOfMonth(1)), isoOf(dayOfMonth(9))),
			calEntry('하루 일', isoOf(dayOfMonth(3))),
		]);

		const spans = calWeeks(containerEl)
			.map((weekEl) => calSlots(weekEl).map((el) => ({ el, ...slotAt(el) })).filter((s) => itemTextOf({ itemEl: calItemEl(s.el) }) === '긴 일'))
			.filter((list) => list.length > 0);

		check('주마다 조각이 하나씩이다', spans.every((list) => list.length === 1), spans.map((l) => l.length).join(','));
		check('여러 날은 칸을 가로지르는 한 요소다', spans.some(([slot]) => slot.to > slot.from), spans.map(([s]) => `${s.from}-${s.to}`).join(' '));
		check('조각 길이의 합이 9일이다', spans.reduce((sum, [slot]) => sum + (slot.to - slot.from + 1), 0) === 9);
		check('이름은 조각마다 쓴다', spans.every(([slot]) => calItemEl(slot.el).find('bases-plus-cal-item-text').text === '긴 일'));

		const first = spans[0][0];
		const last = spans[spans.length - 1][0];
		check('첫 조각은 왼쪽 모서리가 살아 있다', !calItemEl(first.el).hasClass('is-clipped-start'));
		check('마지막 조각은 오른쪽 모서리가 살아 있다', !calItemEl(last.el).hasClass('is-clipped-end'));
		check('주 경계에서 끊긴 쪽은 각지다',
			calItemEl(first.el).hasClass('is-clipped-end') && calItemEl(last.el).hasClass('is-clipped-start'));

		// 하루짜리는 막대가 잡은 줄을 피한다 — 줄이 그리드 행이라 자리를 나눠 갖는다(C3-2).
		const third = itemsOn(containerEl, dayOfMonth(3));
		const single = third.find((slot) => itemTextOf(slot) === '하루 일');
		const bar = third.find((slot) => itemTextOf(slot) === '긴 일');
		check('하루짜리는 그 칸에 함께 선다', !!single && !!bar);
		check('하루짜리는 막대 아래 줄이다', single.lane === bar.lane + 1, `${single.lane} / ${bar.lane}`);
		check('하루짜리는 한 칸만 차지한다', single.from === single.to);
		check('하루짜리는 모서리가 온전하다',
			!calItemEl(single.el).hasClass('is-clipped-start') && !calItemEl(single.el).hasClass('is-clipped-end'));
		view.unload();
	}

	console.log('\n[65] +N 접기와 펼침 — 되접기 없음·여러 줄 동시 (1차 8·9번)');
	resetStubs();
	{
		const at = dayOfMonth(12);
		const other = dayOfMonth(20);
		const entries = [];
		for (let i = 0; i < 5; i++) entries.push(calEntry(`항목 ${i}`, isoOf(at)));
		for (let i = 0; i < 4; i++) entries.push(calEntry(`다른 줄 ${i}`, isoOf(other)));

		const { view, containerEl, config } = await mountCalendar(entries);

		check('기본은 세 개만 보인다', itemsOn(containerEl, at).length === 3, String(itemsOn(containerEl, at).length));
		check('넘친 수가 +N 으로 선다', moreOn(containerEl, at).text === '+2', moreOn(containerEl, at).text);
		check('+N 은 마지막 줄 자리에 선다', Number(moreOn(containerEl, at).style.gridRow) === 5);

		moreOn(containerEl, at).dispatch('click');
		check('누르면 그 칸의 항목이 전부 보인다', itemsOn(containerEl, at).length === 5, String(itemsOn(containerEl, at).length));
		// 되접는 단추를 두지 않는다 — 초기화는 기간 이동으로 충분하다(마스터 1차 8번).
		check('되접는 단추를 두지 않는다', moreOn(containerEl, at) === null);
		check('펼친 줄에 표식이 붙는다', findDay(containerEl, at).week.hasClass('is-expanded'));
		check('다른 줄은 접힌 채다', !findDay(containerEl, other).week.hasClass('is-expanded'));

		moreOn(containerEl, other).dispatch('click');
		// 앞서 펼친 줄이 접힐 필요는 없다(마스터 1차 9번).
		check('여러 줄을 함께 펼친다',
			findDay(containerEl, at).week.hasClass('is-expanded') && findDay(containerEl, other).week.hasClass('is-expanded'));
		check('두 줄 모두 전부 보인다', itemsOn(containerEl, at).length === 5 && itemsOn(containerEl, other).length === 4);

		containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button')[1].dispatch('click');
		check('기간을 옮기면 펼침이 풀린다', calWeeks(containerEl).every((el) => !el.hasClass('is-expanded')));
		check('펼침을 저장하지 않는다', Object.keys(config.stored).every((key) => key.indexOf('expand') === -1));

		containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button')[0].dispatch('click');
		view.config.set('itemsPerDay', '5');
		view.onDataUpdated();
		check('Items per day 를 올리면 접히지 않는다', itemsOn(containerEl, at).length === 5 && moreOn(containerEl, at) === null);
		view.unload();
	}

	console.log('\n[66] 기간 이동·주 보기 — 최소 7줄·+N 없음 (1차 요청)');
	resetStubs();
	{
		const entries = [];
		for (let i = 0; i < 5; i++) entries.push(calEntry(`항목 ${i}`, isoOf(todayDate())));

		const { view, containerEl, config } = await mountCalendar(entries);
		const periodEl = containerEl.find('bases-plus-cal-period');
		const buttons = containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button');
		const monthWeeks = calWeeks(containerEl).length;
		const title = periodEl.text;

		check('기간 이름이 화면 언어로 선다', /\d{4}/.test(title), title);
		buttons[1].dispatch('click');
		check('다음 달로 넘어간다', periodEl.text !== title);
		buttons[0].dispatch('click');
		check('이전 버튼이 되돌린다', periodEl.text === title);
		buttons[0].dispatch('click');
		containerEl.find('bases-plus-cal-today').dispatch('click');
		check('오늘 버튼이 이번 달로 돌아온다', periodEl.text === title && calWeeks(containerEl).length === monthWeeks);
		check('보는 기간을 저장하지 않는다', config.stored.anchor === undefined);

		const modes = containerEl.findAll('bases-plus-cal-mode');
		check('월이 기본으로 눌려 있다', modes[0].hasClass('is-active') && !modes[1].hasClass('is-active'));
		modes[1].dispatch('click');
		check('주 보기는 한 줄이다', calWeeks(containerEl).length === 1);
		check('주 보기 표식이 붙는다', containerEl.find('bases-plus-calendar').hasClass('is-week'));
		check('주 보기는 이번 달 밖 개념이 없다', calDayBgs(calWeeks(containerEl)[0]).every((el) => !el.hasClass('is-outside')));
		check('주 보기는 오늘이 든 주를 연다', calDayBgs(calWeeks(containerEl)[0]).some((el) => el.hasClass('is-today')));
		// 주 보기는 `+N` 없이 전부 보여 주고 줄을 최소 7개 잡는다(마스터 1차 요청).
		check('주 보기는 +N 이 없다', calMores(calWeeks(containerEl)[0]).length === 0);
		check('주 보기는 항목을 전부 보여준다', itemsOn(containerEl, todayDate()).length === 5);
		const rows = String(calWeeks(containerEl)[0].style.gridTemplateRows || '');
		check('주 보기는 줄을 최소 7개 잡는다', rows.indexOf('repeat(7,') !== -1, rows);
		check('보기 종류는 저장한다', config.stored.calendarView === 'week');

		modes[0].dispatch('click');
		check('월로 되돌아온다', calWeeks(containerEl).length === monthWeeks && config.stored.calendarView === 'month');
		check('되돌아온 달이 같은 달이다', periodEl.text === title, periodEl.text);
		view.unload();
	}

	console.log('\n[67] tasks — 자체 파서 (명세 D · 함정 A~D)');
	resetStubs();
	{
		const at = dayOfMonth(14);
		const entry = calEntry('업무 노트', isoOf(dayOfMonth(2)), isoOf(dayOfMonth(4)));
		const { view, containerEl, app } = await mountCalendar([entry], { showTasks: true, itemsPerDay: '6' });

		app.vault.contents[entry.file.path] = [
			'# 제목',
			`- [ ] 측정 기준 정리 📅 ${isoOf(at)}`,
			`- [x] 코워크 이관 📅 ${isoOf(at)} ✅ ${isoOf(at)}`,
			`- [-] 취소된 일 📅 ${isoOf(at)} ❌ ${isoOf(at)}`,
			'- [ ] 기한 없는 일',
			`- [ ] dataview 형식 [due:: ${isoOf(at)}]`,
			'평범한 줄',
		].join('\n');
		app.metadataCache.caches[entry.file.path] = {
			listItems: [
				{ task: ' ', position: { start: { line: 1 } } },
				{ task: 'x', position: { start: { line: 2 } } },
				{ task: '-', position: { start: { line: 3 } } },
				{ task: ' ', position: { start: { line: 4 } } },
				{ task: ' ', position: { start: { line: 5 } } },
			],
		};

		// 첫 렌더는 파일 칩만이다 — 아직 모르는 것을 없다고 말하지 않는다(D3).
		check('태스크 수집 전에는 태스크 줄이 없다', containerEl.findAll('bases-plus-cal-task').filter((el) => !el.hidden).length === 0);
		check('"태스크 없음" 문구를 만들지 않는다', containerEl.find('bases-plus-notice').hidden);

		view.data = new BasesQueryResult([entry], CAL_PROPS);
		view.onDataUpdated();
		await new Promise((resolve) => setTimeout(resolve, 260));

		const tasks = itemsOn(containerEl, at).filter((slot) => slot.taskEl);
		const taskOf = (text) => tasks.find((slot) => taskTextOf(slot) === text);
		const texts = tasks.map(taskTextOf);

		check('태스크가 자기 기한 칸에 선다', tasks.length === 3, String(tasks.length));
		check('미완은 빈 네모다', !!taskOf('측정 기준 정리') && taskOf('측정 기준 정리').taskEl.find('bases-plus-cal-check').text === '☐');
		check('완료는 취소선이 붙는다', !!taskOf('코워크 이관') && taskOf('코워크 이관').taskEl.hasClass('is-done'));
		check('취소는 완료와 다른 표식이다',
			!!taskOf('취소된 일') && taskOf('취소된 일').taskEl.hasClass('is-cancelled') && !taskOf('취소된 일').taskEl.hasClass('is-done'));
		check('완료·취소 글리프가 갈린다',
			taskOf('코워크 이관').taskEl.find('bases-plus-cal-check').text === '☑' &&
			taskOf('취소된 일').taskEl.find('bases-plus-cal-check').text === '☒');
		check('하루짜리와 태스크는 이름순으로 섞인다', texts.join(',') === texts.slice().sort((a, b) => a.localeCompare(b)).join(','), texts.join(','));
		check('기한 없는 태스크는 안 나온다', texts.indexOf('기한 없는 일') === -1);
		check('dataview 형식은 안 잡힌다(알려진 한계)', texts.every((text) => text.indexOf('dataview') === -1));
		check('설명에서 이모지·날짜를 뗀다', texts.indexOf('코워크 이관') !== -1, texts.join(','));
		check('파일 칩은 자기 날짜 칸에 그대로 있다', itemsOn(containerEl, dayOfMonth(2)).some((slot) => slot.itemEl));
		check('본문을 읽은 파일은 태스크가 있는 파일뿐이다', new Set(app.vault.reads).size === 1, app.vault.reads.join(','));

		const before = app.vault.reads.length;
		view.data = new BasesQueryResult([entry], CAL_PROPS);
		view.onDataUpdated();
		await new Promise((resolve) => setTimeout(resolve, 20));
		check('수정 시각이 같으면 본문을 다시 읽지 않는다', app.vault.reads.length === before, String(app.vault.reads.length));

		entry.file.stat.mtime = 5;
		view.data = new BasesQueryResult([entry], CAL_PROPS);
		view.onDataUpdated();
		await new Promise((resolve) => setTimeout(resolve, 20));
		check('파일이 바뀌면 다시 읽는다', app.vault.reads.length === before + 1);
		view.unload();
	}

	console.log('\n[68] tasks — Tasks 플러그인 경로 (판정 ③)');
	resetStubs();
	{
		const at = dayOfMonth(16);
		const entry = calEntry('업무 노트', isoOf(dayOfMonth(2)));
		const made = makeApp('visible', null, CAL_TYPES);
		// Tasks 가 듣고 있는 상황 — 요청을 받으면 그 자리에서 스냅숏을 돌려준다.
		made.app.workspace.on('obsidian-tasks-plugin:request-cache-update', (callback) => {
			callback({
				tasks: [
					{
						description: 'Tasks 가 해석한 일',
						status: { symbol: ' ', type: 'TODO' },
						dueDate: { format: () => isoOf(at) },
						taskLocation: { path: entry.file.path, lineNumber: 3 },
					},
				],
				state: 'Warm',
			});
		});

		const exported = require(BUNDLE);
		const PluginClass = exported.default || exported;
		const plugin = new PluginClass(made.app, { id: 'bases-plus' });
		await plugin.onload();
		const registration = plugin.basesViews.find((item) => item.id === 'bases-plus-calendar').registration;
		const containerEl = new FakeEl('div', 'bases-view');
		const view = registration.factory({ app: made.app }, containerEl);
		view.config = makeConfig({ stored: { startDate: 'note.start', endDate: 'note.end', showTasks: true } });
		view.allProperties = CAL_PROPS;
		view.data = new BasesQueryResult([entry], CAL_PROPS);
		made.app.vault.files[entry.file.path] = entry.file;
		view.onDataUpdated();
		await new Promise((resolve) => setTimeout(resolve, 20));

		const tasks = itemsOn(containerEl, at).filter((slot) => slot.taskEl);
		check('Tasks 가 준 태스크가 선다', tasks.length === 1 && taskTextOf(tasks[0]) === 'Tasks 가 해석한 일');
		check('본문을 읽지 않는다', made.app.vault.reads.length === 0, made.app.vault.reads.join(','));
		check('app.plugins 를 보지 않는다', made.app.plugins === undefined);

		made.app.workspace.trigger('obsidian-tasks-plugin:cache-update', {
			tasks: [
				{
					description: '갱신된 일',
					status: { symbol: 'x' },
					dueDate: { format: () => isoOf(at) },
					taskLocation: { path: entry.file.path, lineNumber: 3 },
				},
			],
			state: 'Warm',
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const after = itemsOn(containerEl, at).filter((slot) => slot.taskEl);
		check('캐시 갱신이 화면에 반영된다', after.length === 1 && taskTextOf(after[0]) === '갱신된 일');
		check('완료 상태가 넘어온다', after[0].taskEl.hasClass('is-done'));
		view.unload();
	}

	console.log('\n[69] 열기·우클릭·추가 버튼 (명세 C4·E · 1차 19번)');
	resetStubs();
	{
		const at = dayOfMonth(11);
		const { view, containerEl, opened } = await mountCalendar([calEntry('Note A', isoOf(at))], { openMode: 'tab' });
		const slot = itemsOn(containerEl, at)[0];

		slot.el.dispatch('click', { button: 0 });
		await wait();
		check('항목을 누르면 설정된 방식으로 연다', opened.tabs.length === 1 && opened.tabs[0].file.basename === 'Note A');

		slot.el.dispatch('contextmenu');
		check('우클릭 메뉴가 한 항목이다', Menu.instances.length === 1 && Menu.instances[0].items.length === 1);
		check('메뉴 문구가 확정분과 같다', Menu.instances[0].items[0].title === 'Open with Bases Plus');

		// `+` 는 날짜 옆에 있고 **항목이 있든 없든** 같은 자리다(마스터 1차 19번).
		const busy = findDay(containerEl, at);
		const empty = findDay(containerEl, dayOfMonth(at.getDate() === 1 ? 2 : 1));
		check('추가 버튼이 날짜 줄 안에 있다', !!busy.head.find('bases-plus-cal-add'));
		check('항목이 있는 칸에도 추가 버튼이 있다', !!empty.head.find('bases-plus-cal-add') && !!busy.head.find('bases-plus-cal-add'));

		empty.head.find('bases-plus-cal-add').dispatch('click');
		await wait();
		check('추가 버튼이 그 날짜로 항목을 만든다',
			BasesView.created.length === 1 && BasesView.created[0].frontmatter.start === isoOf(dayOfMonth(at.getDate() === 1 ? 2 : 1)),
			JSON.stringify(BasesView.created));

		busy.head.find('bases-plus-cal-add').dispatch('click');
		await wait();
		check('항목이 있는 칸에서도 만들어진다', BasesView.created.length === 2 && BasesView.created[1].frontmatter.start === isoOf(at));
		view.unload();
	}

	console.log('\n[70] 속성 표시 — 칩 안에 "이름: 값" 목록 (1차 22번 수정)');
	resetStubs();
	{
		const at = dayOfMonth(9);
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(at), null, '진행중')]);
		const slot = itemsOn(containerEl, at)[0];
		const propsEl = slot.el.find('bases-plus-cal-item-props');

		check('속성 목록이 칩 안에 있다', !propsEl.hidden && propsEl.parent.hasClass('bases-plus-cal-item'));
		check('속성 한 줄이 이름과 값이다',
			propsEl.children.length === 1 &&
			propsEl.children[0].find('bases-plus-cal-prop-name').text === 'status' &&
			propsEl.children[0].find('bases-plus-cal-prop-value').text === '진행중');
		check('값은 renderTo 로 그린다', propsEl.children[0].find('bases-plus-cal-prop-value').hasClass('bases-rendered-value'));
		check('이름은 다시 그리지 않는다', propsEl.textContent.indexOf('Note A') === -1);

		view.data = new BasesQueryResult([calEntry('Note A', isoOf(at))], ['file.name']);
		view.onDataUpdated();
		const after = itemsOn(containerEl, at)[0].el.find('bases-plus-cal-item-props');
		// 줄은 풀에서 재사용하므로 요소가 남는다 — **보이는 줄이 없어야** 한다(성2와 같은 규칙).
		check('속성을 끄면 목록이 사라진다',
			after.hidden && after.findAll('bases-plus-cal-item-prop').every((el) => el.hidden));
		view.unload();
	}

	console.log('\n[71] 임베드에서 잘리면 주 보기를 권한다 (명세 A4)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))]);
		const notice = containerEl.find('bases-plus-notice');

		check('잘리지 않으면 띠가 없다', notice.hidden);

		const embedEl = { clientHeight: 200 };
		containerEl.closest = (selector) => (selector === '.bases-embed' ? embedEl : null);
		containerEl.find('bases-plus-view').scrollHeight = 610;
		view.onDataUpdated();
		check('잘리면 주 보기를 권한다',
			!containerEl.find('bases-plus-notice').hidden &&
			containerEl.find('bases-plus-notice').text === 'This calendar is taller than the embed. Set a height on the embed or use week view.');

		containerEl.find('bases-plus-view').scrollHeight = 180;
		view.onDataUpdated();
		check('들어가면 띠가 사라진다', containerEl.find('bases-plus-notice').hidden);
		view.unload();
	}

	console.log('\n[74] 년·월 선택 창 (1차 요청)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))]);
		const periodEl = containerEl.find('bases-plus-cal-period');
		const title = periodEl.text;

		periodEl.dispatch('click');
		const modal = Modal.instances[Modal.instances.length - 1];
		check('기간 이름을 누르면 창이 뜬다', !!modal && modal.isOpen);
		check('확정분 대화상자 어휘를 쓴다', modal.modalEl.hasClass('bases-plus-modal'));
		check('월 12칸이 선다', modal.contentEl.findAll('bases-plus-period-month').length === 12);
		check('지금 달에 표식이 있다', modal.contentEl.findAll('bases-plus-period-month').filter((el) => el.hasClass('is-current')).length === 1);
		check('년 이동이 표 페이저 버튼 어휘다', modal.contentEl.findAll('bases-plus-pager-button').length === 2);

		const year = modal.contentEl.find('bases-plus-period-year').text;
		modal.contentEl.findAll('bases-plus-pager-button')[1].dispatch('click');
		check('년을 넘길 수 있다', modal.contentEl.find('bases-plus-period-year').text !== year);
		check('년만 넘겨서는 달력이 안 바뀐다', periodEl.text === title);

		modal.contentEl.findAll('bases-plus-period-month')[0].dispatch('click');
		check('월을 고르면 그 기간으로 간다', periodEl.text !== title, periodEl.text);
		check('고르면 창이 닫힌다', !modal.isOpen);
		view.unload();
	}

	console.log('\n[75] 칩 안 조작 — 체크박스·목록 속성 골격 (1차 요청)');
	resetStubs();
	{
		const at = dayOfMonth(18);
		const entry = calEntry('Note A', isoOf(at), null, '진행중', false);
		const { view, containerEl, frontmatter } = await mountCalendar([entry], {
			checkboxProperty: 'note.완료',
			listProperty: 'note.status',
		});
		const slot = itemsOn(containerEl, at)[0];
		const checkEl = slot.el.find('bases-plus-cal-check-box');
		const pillEl = slot.el.find('bases-plus-cal-item-pill');

		check('체크박스가 제목 앞에 선다', !checkEl.hidden && checkEl.parent.hasClass('bases-plus-cal-item-head'));
		check('꺼진 체크박스는 빈 네모다', checkEl.text === '☐' && !checkEl.hasClass('is-checked'));
		check('목록 값이 칩에 보인다', !pillEl.hidden && pillEl.text === '진행중');

		checkEl.dispatch('click');
		await wait();
		check('체크박스를 누르면 프론트매터가 바뀐다', frontmatter[entry.file.path]?.완료 === true, JSON.stringify(frontmatter));

		pillEl.dispatch('click');
		const menu = Menu.instances[Menu.instances.length - 1];
		check('값을 누르면 후보가 메뉴로 뜬다', !!menu && menu.items.length >= 1, String(menu && menu.items.length));
		check('지금 값에 표시가 있다', menu.items.some((item) => item.title === '진행중' && item.checked === true));

		menu.items[0].click();
		await wait();
		check('메뉴에서 고르면 프론트매터가 바뀐다', frontmatter[entry.file.path]?.status === '진행중', JSON.stringify(frontmatter));

		// 옵션을 안 고르면 칩은 이름만 갖는다 — 최소 골격이라 조건부로만 선다.
		view.config.set('checkboxProperty', null);
		view.config.set('listProperty', null);
		view.onDataUpdated();
		const bare = itemsOn(containerEl, at)[0];
		check('안 고르면 체크박스·알약이 없다',
			bare.el.find('bases-plus-cal-check-box').hidden && bare.el.find('bases-plus-cal-item-pill').hidden);
		view.unload();
	}

	console.log('\n[76] 호버 — 같은 항목의 조각 전체가 물든다 (1차 요청)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([
			calEntry('긴 일', isoOf(dayOfMonth(1)), isoOf(dayOfMonth(12))),
			calEntry('다른 일', isoOf(dayOfMonth(3))),
		]);
		const slots = calWeeks(containerEl).flatMap(calSlots);
		const longOnes = slots.filter((el) => el.getAttr('data-item') === 'notes/긴 일.md');

		check('주를 넘긴 조각이 둘 이상이다', longOnes.length >= 2, String(longOnes.length));
		check('조각마다 항목 표식이 붙는다', longOnes.every((el) => el.getAttr('data-item') === 'notes/긴 일.md'));

		longOnes[0].dispatch('pointerenter');
		check('같은 항목의 조각이 전부 물든다', longOnes.every((el) => el.hasClass('is-hovered')));
		check('다른 항목은 그대로다', slots.filter((el) => el.getAttr('data-item') === 'notes/다른 일.md').every((el) => !el.hasClass('is-hovered')));

		longOnes[0].dispatch('pointerleave');
		check('벗어나면 풀린다', slots.every((el) => !el.hasClass('is-hovered')));
		view.unload();
	}

	console.log('\n[77] 칩 색 — 기본은 거의 없고 Color by 로 들어온다 (2차 8번)');
	resetStubs();
	{
		const at = dayOfMonth(6);
		const entries = [
			calEntry('진행 노트', isoOf(at), null, '진행중'),
			calEntry('완료 노트', isoOf(at), null, '완료'),
			calEntry('긴 일', isoOf(dayOfMonth(2)), isoOf(dayOfMonth(9)), '진행중'),
		];
		const { view, containerEl, config } = await mountCalendar(entries);
		const itemOf = (text) => itemsOn(containerEl, at).find((slot) => itemTextOf(slot) === text).itemEl;

		check('색을 안 켜면 칩에 색 표식이 없다', !itemOf('진행 노트').hasClass('is-tinted'));
		check('머리 팔레트 버튼이 감춰져 있다', containerEl.find('bases-plus-cal-tool').hidden);

		view.config.set('colorBy', 'note.status');
		view.onDataUpdated();
		check('색을 켜면 칩에 표식이 붙는다', itemOf('진행 노트').hasClass('is-tinted'));
		check('값이 다르면 색이 갈린다',
			itemOf('진행 노트').style['--bases-plus-cal-color'] !== itemOf('완료 노트').style['--bases-plus-cal-color'],
			`${itemOf('진행 노트').style['--bases-plus-cal-color']} / ${itemOf('완료 노트').style['--bases-plus-cal-color']}`);
		// 색은 커스텀 속성으로만 들어간다 — setCssStyles 는 `--x` 를 조용히 버린다(타임라인 실측).
		check('색이 커스텀 속성으로 들어간다', /^var\(--bases-plus-series-\d\)$/.test(itemOf('진행 노트').style['--bases-plus-cal-color']));
		check('팔레트 버튼이 드러난다', !containerEl.find('bases-plus-cal-tool').hidden);

		// 왼쪽 띠는 기간이 **실제로 시작하는 조각에만** 선다.
		const pieces = calWeeks(containerEl)
			.flatMap(calSlots)
			.filter((el) => el.getAttr('data-item') === 'notes/긴 일.md')
			.map((el) => el.find('bases-plus-cal-item'));
		check('띠는 시작 조각에만 붙는다',
			pieces.filter((el) => el.hasClass('is-band')).length === 1,
			pieces.map((el) => (el.hasClass('is-band') ? 'band' : '-')).join(','));

		containerEl.find('bases-plus-cal-tool').dispatch('click');
		const modal = Modal.instances[Modal.instances.length - 1];
		check('팔레트가 타임라인과 같은 대화상자다', !!modal && modal.modalEl.hasClass('bases-plus-bar-color-modal'));
		modal.contentEl.findAll('bases-plus-bar-color-swatch')[2].dispatch('click');
		check('고른 색이 타임라인과 같은 키에 저장된다', !!config.stored.barColors, JSON.stringify(config.stored.barColors));
		view.unload();
	}

	console.log('\n[78] 속성 줄 — 정렬·표시 방식·빈 값 (2차 10번)');
	resetStubs();
	{
		const at = dayOfMonth(7);
		const entry = makeEntry('Note A', {
			'file.file': fileValue('Note A'),
			'note.start': dateValue(isoOf(at)),
			'note.status': textValue('진행중'),
			'note.due': nullValue(),
		});
		const { view, containerEl } = await mountCalendar([entry], {}, { properties: ['file.name', 'note.status', 'note.due'] });
		const rowsOf = () => itemsOn(containerEl, at)[0].el.findAll('bases-plus-cal-item-prop').filter((el) => !el.hidden);

		// 이름과 값이 **두 열 그리드**라 줄마다 값이 같은 x 에서 시작한다(캡처 지적).
		check('이름과 값이 한 줄의 두 조각이다',
			rowsOf()[0].children.length === 2 &&
			rowsOf()[0].children[0].hasClass('bases-plus-cal-prop-name') &&
			rowsOf()[0].children[1].hasClass('bases-plus-cal-prop-value'));
		check('빈 값 줄은 기본으로 접힌다', rowsOf().length === 1, String(rowsOf().length));

		view.config.set('showEmptyProperties', true);
		view.onDataUpdated();
		check('켜면 빈 값도 줄을 세운다', rowsOf().length === 2, String(rowsOf().length));
		check('빈 값은 자리표시자를 세운다', !!rowsOf()[1].find('bases-plus-cal-prop-empty'));

		view.config.set('propertyDisplay', 'values');
		view.onDataUpdated();
		check('값만 보기에서는 이름을 감춘다', rowsOf().every((el) => el.find('bases-plus-cal-prop-name').hidden));
		check('값만 보기 표식이 붙는다', itemsOn(containerEl, at)[0].el.find('bases-plus-cal-item-props').hasClass('is-values-only'));
		// 두 옵션은 **조합으로** 동작한다(3차 6번 — 값만 보기에서 빈 값 옵션이 안 먹는 것으로 보였다).
		check('값만 보기에서도 빈 값 줄이 선다', rowsOf().length === 2, String(rowsOf().length));
		check('빈 값은 여기서도 자리표시자를 세운다', !!rowsOf()[1].find('bases-plus-cal-prop-empty'));
		// 이름이 없으니 **툴팁이 어떤 속성인지 답한다**(모호함 처리).
		check('값에 속성 이름이 툴팁으로 붙는다',
			rowsOf()[0].find('bases-plus-cal-prop-value').getAttr('aria-label') === 'status',
			String(rowsOf()[0].find('bases-plus-cal-prop-value').getAttr('aria-label')));

		view.config.set('showEmptyProperties', false);
		view.onDataUpdated();
		check('값만 보기에서 끄면 빈 줄이 사라진다', rowsOf().length === 1, String(rowsOf().length));
		view.unload();
	}

	console.log('\n[79] 칩 안 바로 수정 — 목록형·날짜·체크박스 (2차 10번)');
	resetStubs();
	{
		const at = dayOfMonth(8);
		const entry = makeEntry('Note A', {
			'file.file': fileValue('Note A'),
			'note.start': dateValue(isoOf(at)),
			'note.status': textValue('진행중'),
			'note.due': dateValue(isoOf(dayOfMonth(20))),
			'note.완료': boolValue(false),
			'note.priority': numberValue(3),
		});
		const { view, containerEl, frontmatter, opened } = await mountCalendar([entry], {}, {
			properties: ['file.name', 'note.status', 'note.due', 'note.완료', 'note.priority'],
			types: Object.assign({}, CAL_TYPES, { due: 'date', 테스트: 'multitext' }),
		});
		const rows = () => itemsOn(containerEl, at)[0].el.findAll('bases-plus-cal-item-prop').filter((el) => !el.hidden);
		const rowFor = (name) => rows().find((el) => el.find('bases-plus-cal-prop-name').text === name);

		check('고칠 수 있는 줄에만 표식이 붙는다',
			rowFor('due').hasClass('is-editable') && rowFor('완료').hasClass('is-editable') && !rowFor('priority').hasClass('is-editable'),
			rows().map((el) => `${el.find('bases-plus-cal-prop-name').text}:${el.hasClass('is-editable')}`).join(' '));

		rowFor('완료').find('bases-plus-cal-prop-value').dispatch('click');
		await wait();
		check('체크박스 값을 누르면 뒤집힌다', frontmatter[entry.file.path]?.완료 === true, JSON.stringify(frontmatter));

		rowFor('due').find('bases-plus-cal-prop-value').dispatch('click');
		check('날짜 값을 누르면 그 자리에 입력칸이 뜬다', !!rowFor('due').find('bases-plus-cal-cell-input') || !!rowFor('due').find('bases-plus-cell-input'));
		check('수정 클릭이 열기로 새지 않는다', opened.tabs.length === 0 && Modal.instances.length === 0);
		view.unload();
	}

	console.log('\n[80] 체크박스 — 속성이 없는 노트 (2차 11번 하위)');
	resetStubs();
	{
		const at = dayOfMonth(5);
		const has = calEntry('있는 노트', isoOf(at), null, '진행중', false);
		const missing = calEntry('없는 노트', isoOf(at), null, '진행중');
		const { view, containerEl } = await mountCalendar([has, missing], { checkboxProperty: 'note.완료' });
		const boxOf = (name) => itemsOn(containerEl, at).find((slot) => itemTextOf(slot) === name).el.find('bases-plus-cal-check-box');

		check('속성이 있는 노트에는 체크박스가 선다', !boxOf('있는 노트').hidden);
		// 없는 속성 자리에 컨트롤을 세우면 눌렀을 때 없던 키가 생긴다 — 기본은 안 세운다.
		check('속성이 없는 노트에는 기본으로 안 세운다', boxOf('없는 노트').hidden);

		view.config.set('checkboxWhenMissing', true);
		view.onDataUpdated();
		check('옵션을 켜면 없는 노트에도 세운다', !boxOf('없는 노트').hidden);
		check('그 체크박스는 꺼진 상태다', boxOf('없는 노트').text === '☐');
		view.unload();
	}

	console.log('\n[81] 끝단 드래그 — 포인터가 선 칸이 목표 날짜다 (2·3차 요청)');
	resetStubs();
	{
		const from = dayOfMonth(12);
		const to = dayOfMonth(14);
		const entry = calEntry('기간 일', isoOf(from), isoOf(to));
		const single = calEntry('하루 일', isoOf(dayOfMonth(16)));
		const { view, containerEl, frontmatter } = await mountCalendar([entry, single]);
		layoutCalendar(containerEl);

		const rootEl = containerEl.find('bases-plus-view');
		const slotOf = (name, date) => itemsOn(containerEl, date).find((slot) => itemTextOf(slot) === name);
		const span = slotOf('기간 일', from);
		check('기간 항목에 양 끝 손잡이가 선다',
			!span.el.find('bases-plus-cal-handle').hidden && !span.el.findAll('bases-plus-cal-handle')[1].hidden);

		const endHandle = span.el.findAll('bases-plus-cal-handle')[1];
		const target = dayOfMonth(17);
		const columnBefore = span.el.style.gridColumn;
		grabAt(containerEl, endHandle, to, 1);
		dragTo(containerEl, to, 1);
		// 같은 칸 안에서는 날짜가 안 바뀌므로 자리도 그대로다 — 클릭과 드래그를 가르는 경계(확정 5).
		check('같은 칸 안에서는 자리를 안 바꾼다', span.el.style.gridColumn === columnBefore, `${columnBefore} -> ${span.el.style.gridColumn}`);

		dragTo(containerEl, target, 1);
		dropAt(containerEl, target, 1);
		await wait();
		check('끝을 끌면 포인터가 선 칸의 날짜가 종료가 된다',
			frontmatter[entry.file.path]?.end === isoOf(target), JSON.stringify(frontmatter[entry.file.path]));
		check('시작은 건드리지 않는다', frontmatter[entry.file.path]?.start === undefined);
		check('놓으면 드래그가 끝난다', !containerEl.findAll('bases-plus-cal-item').some((el) => el.hasClass('is-dragging')));
		check('놓으면 루트가 캡처를 놓는다', rootEl.captured === null);

		// 하루짜리를 끌면 **기간이 된다** — 없던 종료가 이때 생긴다.
		const one = slotOf('하루 일', dayOfMonth(16));
		grabAt(containerEl, one.el.findAll('bases-plus-cal-handle')[1], dayOfMonth(16), 2);
		dragTo(containerEl, dayOfMonth(18), 2);
		dropAt(containerEl, dayOfMonth(18), 2);
		await wait();
		check('하루짜리를 끌면 기간이 된다', frontmatter[single.file.path]?.end === isoOf(dayOfMonth(18)), JSON.stringify(frontmatter[single.file.path]));

		// 뒤집힌 기간을 만들지 않는다 — 시작을 종료 뒤로 끌면 종료에서 멈춘다.
		const span2 = slotOf('기간 일', from);
		grabAt(containerEl, span2.el.find('bases-plus-cal-handle'), from, 3);
		dragTo(containerEl, dayOfMonth(20), 3);
		dropAt(containerEl, dayOfMonth(20), 3);
		await wait();
		check('시작을 종료 뒤로 끌면 종료에서 멈춘다',
			frontmatter[entry.file.path]?.start === isoOf(to), JSON.stringify(frontmatter[entry.file.path]));
		check('손잡이 클릭은 열기로 새지 않는다', Modal.instances.length === 0);

		/*
		 * 끈 직후의 클릭은 삼키고 **그 뒤의 클릭은 산다.** 표식으로 두면 그 클릭이 우리 슬롯이 아니라
		 * 캡처를 쥔 루트로 갈 때 표식이 남아 다음 진짜 클릭까지 삼킨다 — 열기가 조용히 죽는 종류다.
		 */
		const opener = slotOf('기간 일', from);
		opener.el.dispatch('click', { button: 0 });
		await wait();
		check('끈 직후의 클릭은 열지 않는다', Modal.instances.length === 0);
		await new Promise((resolve) => setTimeout(resolve, 260));
		opener.el.dispatch('click', { button: 0 });
		await wait();
		check('그 뒤의 클릭은 평소대로 연다', Modal.instances.length === 1, String(Modal.instances.length));
		view.unload();
	}

	console.log('\n[83] 드래그 — 캡처가 재배치를 견딘다 (4차 4·5번의 원인)');
	resetStubs();
	{
		const a = calEntry('A 일정', isoOf(dayOfMonth(10)), isoOf(dayOfMonth(12)));
		const b = calEntry('B 일정', isoOf(dayOfMonth(13)), isoOf(dayOfMonth(14)));
		const { view, containerEl, frontmatter } = await mountCalendar([a, b]);
		layoutCalendar(containerEl);

		const rootEl = containerEl.find('bases-plus-view');
		const slotOf = (name, date) => itemsOn(containerEl, date).find((slot) => itemTextOf(slot) === name);
		const aEnd = slotOf('A 일정', dayOfMonth(10)).el.findAll('bases-plus-cal-handle')[1];

		grabAt(containerEl, aEnd, dayOfMonth(12), 1);
		/*
		 * **캡처는 뷰 루트가 쥔다.** 손잡이에 쥐게 하면 미리보기가 그리드를 다시 배치하는 순간 그 요소가
		 * 부모에 다시 붙어 실물 DOM 이 캡처를 암묵 해제한다 — 그 뒤로는 떼도 드래그가 안 끝난다(4차 4번).
		 */
		check('캡처를 루트가 쥔다', rootEl.captured === 1 && aEnd.captured === null);

		dragTo(containerEl, dayOfMonth(14), 1);
		check('미리보기로 다시 배치해도 캡처가 남는다', rootEl.captured === 1);

		// 미리보기는 **끝난 뒤와 같은 모습**이어야 한다 — 끌던 칩만 옮기면 이웃 위에 겹쳐 그려진다.
		const bDuring = slotOf('B 일정', dayOfMonth(13));
		const aDuring = slotOf('A 일정', dayOfMonth(10));
		check('미리보기에서 이웃이 다른 줄로 밀린다', slotAt(bDuring.el).lane !== slotAt(aDuring.el).lane,
			`A lane ${slotAt(aDuring.el).lane} / B lane ${slotAt(bDuring.el).lane}`);

		dropAt(containerEl, dayOfMonth(14), 1);
		await wait();
		check('끈 항목만 저장된다', !!frontmatter[a.file.path] && !frontmatter[b.file.path], JSON.stringify(frontmatter));
		check('놓으면 드래그가 끝난다', !containerEl.findAll('bases-plus-cal-item').some((el) => el.hasClass('is-dragging')));

		/*
		 * 갇힌 드래그가 없어야 **다음 제스처가 자기 항목에 간다.** 예전에는 앞 드래그가 안 끝나 이웃을
		 * 잡아도 앞 항목이 바뀌었다 — 마스터가 "옆 일정이 같이 변한다"로 본 경로다(4차 4번 재현으로 확정).
		 */
		layoutCalendar(containerEl);
		const bStart = slotOf('B 일정', dayOfMonth(13)).el.find('bases-plus-cal-handle');
		grabAt(containerEl, bStart, dayOfMonth(13), 1);
		dragTo(containerEl, dayOfMonth(11), 1);
		dropAt(containerEl, dayOfMonth(11), 1);
		await wait();
		check('다음 제스처는 자기 항목에 간다', frontmatter[b.file.path]?.start === isoOf(dayOfMonth(11)), JSON.stringify(frontmatter));

		// 주를 넘는 드래그 — 위 줄의 날짜로 올라간다(3차 11번 ⓑ).
		const long = calEntry('두 주 일', isoOf(dayOfMonth(3)), isoOf(dayOfMonth(17)));
		view.data = new BasesQueryResult([long], CAL_PROPS);
		view.onDataUpdated();
		layoutCalendar(containerEl);

		const pieces = calWeeks(containerEl).flatMap(calSlots).filter((el) => el.getAttr('data-item') === 'notes/두 주 일.md');
		const endOfLast = pieces[pieces.length - 1].findAll('bases-plus-cal-handle')[1];
		const upper = dayOfMonth(11);
		grabAt(containerEl, endOfLast, dayOfMonth(17), 4);
		dragTo(containerEl, upper, 4);
		dropAt(containerEl, upper, 4);
		await wait();
		check('위 줄의 날짜로 올라간다', frontmatter[long.file.path]?.end === isoOf(upper), JSON.stringify(frontmatter[long.file.path]));

		// Esc 로 멈추면 저장하지 않는다.
		layoutCalendar(containerEl);
		const again = calWeeks(containerEl).flatMap(calSlots).filter((el) => el.getAttr('data-item') === 'notes/두 주 일.md')[0];
		const before = JSON.stringify(frontmatter[long.file.path]);
		grabAt(containerEl, again.find('bases-plus-cal-handle'), dayOfMonth(3), 5);
		dragTo(containerEl, dayOfMonth(5), 5);
		global.document.listeners
			.filter((l) => l.type === 'keydown')
			.forEach((l) => l.cb({ key: 'Escape', preventDefault() {} }));
		await wait();
		check('Esc 로 멈추면 저장하지 않는다', JSON.stringify(frontmatter[long.file.path]) === before, before);
		check('Esc 뒤에는 드래그가 남지 않는다', containerEl.find('bases-plus-view').captured === null);
		view.unload();
	}

	console.log('\n[84] 몸통 드래그 — 기능 취소분 잔존 0 (마스터 4차 6·7번)');
	resetStubs();
	{
		const at = dayOfMonth(9);
		const entry = calEntry('이동 일', isoOf(at), isoOf(dayOfMonth(11)));
		const { view, containerEl, frontmatter, opened } = await mountCalendar([entry], { openMode: 'tab' });
		layoutCalendar(containerEl);

		const slot = itemsOn(containerEl, at)[0];
		const body = slot.el.find('bases-plus-cal-item');
		const before = JSON.stringify(frontmatter[entry.file.path] ?? null);

		// 몸통을 눌러 끌어도 아무 일도 없다 — 취소된 기능이라 경로가 없어야 한다.
		body.dispatch('pointerdown', Object.assign({ button: 0, pointerId: 1, target: body }, pointOn(containerEl, at)));
		check('몸통을 눌러도 드래그가 시작되지 않는다', containerEl.find('bases-plus-view').captured === null);
		dragTo(containerEl, dayOfMonth(13), 1);
		dropAt(containerEl, dayOfMonth(13), 1);
		await wait();
		check('몸통을 끌어도 날짜가 안 바뀐다', JSON.stringify(frontmatter[entry.file.path] ?? null) === before, before);
		check('몸통에 드래그 표식이 안 붙는다', !body.hasClass('is-dragging'));

		// 칩 클릭 열기는 그대로 산다(8번 성공분).
		slot.el.dispatch('click', { button: 0 });
		await wait();
		check('칩을 누르면 그대로 열린다', opened.tabs.length === 1, String(opened.tabs.length));
		view.unload();
	}

	console.log('\n[72] 요소 재사용 — 갱신마다 다시 만들지 않는다 (성2)');
	resetStubs();
	{
		const at = dayOfMonth(10);
		const entries = [calEntry('Note A', isoOf(at), isoOf(dayOfMonth(13))), calEntry('Note B', isoOf(at))];
		const { view, containerEl } = await mountCalendar(entries);
		const firstWeek = calWeeks(containerEl)[0];
		const firstSlot = calSlots(findDay(containerEl, at).week)[0];
		const before = containerEl.countNodes();
		const listeners = firstSlot.listeners.length;

		for (let i = 0; i < 5; i++) view.onDataUpdated();

		check('주 요소를 재사용한다', calWeeks(containerEl)[0] === firstWeek);
		check('슬롯 요소를 재사용한다', calSlots(findDay(containerEl, at).week)[0] === firstSlot);
		check('갱신해도 노드가 늘지 않는다', containerEl.countNodes() === before, `${before} -> ${containerEl.countNodes()}`);
		check('갱신해도 슬롯 리스너가 누적되지 않는다', firstSlot.listeners.length === listeners);

		const nodes = containerEl.countNodes();
		containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button')[1].dispatch('click');
		containerEl.find('bases-plus-cal-nav').findAll('bases-plus-pager-button')[0].dispatch('click');
		check('기간을 옮겨도 노드가 늘지 않는다', containerEl.countNodes() <= nodes, `${nodes} -> ${containerEl.countNodes()}`);

		view.unload();
		check('뷰 루트를 컨테이너에서 뗀다', containerEl.find('bases-plus-view') === null);
		check('슬롯 리스너를 푼다', firstSlot.listeners.length === 0);
	}

	console.log('\n[73] 렌더가 실패해도 루트를 지우지 않는다 (임베드 함정 B)');
	resetStubs();
	{
		const { view, containerEl } = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))]);

		view.data = { get data() { throw new Error('boom'); } };
		view.onDataUpdated();

		check('루트가 남는다', !!containerEl.find('bases-plus-view'));
		check('오류 줄이 뜬다', !containerEl.find('bases-plus-error').hidden);
		check('문구가 확정분과 같다', containerEl.find('bases-plus-error').text === 'Bases Plus could not render this view. Open the developer console for the reason.');
		view.unload();
	}
}

// ── 그래프 (4단계) ──────────────────────────────────────────────────────────────────
/** x 하나·y 여럿. 값은 전부 **값 객체에서** 읽는 경로를 태운다(숫자·날짜는 화면 글자가 비어 있다). */
const GRAPH_PROPS = ['file.name', 'note.date', 'note.sales'];
/** 두 시리즈가 필요한 자리 — 표시 속성에 숫자 속성을 하나 더 얹는다. */
const GRAPH_TWO = { properties: ['file.name', 'note.date', 'note.sales', 'note.visits'] };
const GRAPH_TYPES = { date: 'date', sales: 'number', visits: 'number', stage: 'text' };
/**
 * 하네스에는 레이아웃이 없어 플롯 상자를 심는다 — 좌표가 서야 축·선·점을 실측할 수 있다.
 * 여백은 뷰가 아는 값과 같다(왼쪽 36 · 오른쪽 8 · 위 8 · 아래 30).
 */
const GRAPH_WIDTH = 640;
const GRAPH_HEIGHT = 240;
const G_LEFT = 36;
const G_RIGHT = GRAPH_WIDTH - 8;
const G_TOP = 8;
const G_BOTTOM = GRAPH_HEIGHT - 30;

function gEntry(name, date, sales, visits, stage) {
	const values = { 'file.file': fileValue(name) };
	if (date !== null && date !== undefined) values['note.date'] = typeof date === 'string' && /^\d{4}-/.test(date) ? dateValue(date) : textValue(String(date));
	if (sales !== null && sales !== undefined) values['note.sales'] = typeof sales === 'number' ? numberValue(sales) : textValue(sales);
	if (visits !== null && visits !== undefined) values['note.visits'] = numberValue(visits);
	if (stage !== undefined) values['note.stage'] = textValue(stage);
	return makeEntry(name, values);
}

async function mountGraph(entries, stored, options) {
	const opts = options || {};
	const made = makeApp('visible', null, opts.types || GRAPH_TYPES);
	const exported = require(BUNDLE);
	const PluginClass = exported.default || exported;
	const plugin = new PluginClass(made.app, { id: 'bases-plus' });
	await plugin.onload();

	const registration = plugin.basesViews.find((item) => item.id === 'bases-plus-graph').registration;
	const containerEl = new FakeEl('div', 'bases-view');
	containerEl.addClass('is-loading');
	const properties = opts.properties || GRAPH_PROPS;
	const config = makeConfig({
		stored: Object.assign({ xProperty: 'note.date' }, stored),
	});

	const view = registration.factory({ app: made.app }, containerEl);
	view.config = config;
	view.allProperties = properties;
	view.data = new BasesQueryResult(entries, properties);
	view.onDataUpdated();

	// 상자를 심고 한 번 더 그린다 — 실물에서는 첫 렌더에 이미 레이아웃이 있다.
	const plotEl = containerEl.find('bases-plus-graph-plot');
	if (plotEl) {
		plotEl.clientWidth = opts.width || GRAPH_WIDTH;
		plotEl.clientHeight = opts.height || GRAPH_HEIGHT;
		view.onDataUpdated();
	}

	return Object.assign({ plugin, view, containerEl, config, registration, properties, plotEl }, made);
}

const gTagged = (el, tag) => (el ? el.children.filter((child) => child.tag === tag) : []);
const gCanvas = (containerEl) => containerEl.find('bases-plus-graph-canvas');
const gGridLines = (containerEl) => gTagged(containerEl.find('bases-plus-graph-grid'), 'line');
const gGridTexts = (containerEl) => gTagged(containerEl.find('bases-plus-graph-grid'), 'text').map((el) => el.text);
const gAxisTexts = (containerEl) => gTagged(containerEl.find('bases-plus-graph-axis'), 'text').map((el) => el.text);
const gAxisLine = (containerEl) => gTagged(containerEl.find('bases-plus-graph-axis'), 'line')[0];
const gPaths = (containerEl) => containerEl.findAll('bases-plus-graph-line');
const gDots = (containerEl) => containerEl.findAll('bases-plus-graph-dot').filter((el) => !el.hidden);
const gLegend = (containerEl) => containerEl.findAll('bases-plus-graph-legend-item').filter((el) => !el.hidden);
/** `M12,34 L56,78` → [[12,34],[56,78]] */
const gPoints = (pathEl) => String(pathEl.attrs.d).split(' ').map((seg) => seg.slice(1).split(',').map(Number));
const gDotAt = (el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
const gColorOf = (el) => el.style['--bases-plus-graph-color'];
const gNotice = (containerEl) => { const el = containerEl.find('bases-plus-notice'); return el && !el.hidden ? el.text : null; };
const gRail = (containerEl) => containerEl.find('bases-plus-graph-rail');
const gRailTrack = (containerEl) => containerEl.find('bases-plus-graph-rail-track');
/**
 * 띠의 치수를 심는다 — 브라우저가 하는 일(스타일 폭 → 실제 폭)을 하네스가 대신한다.
 * 이걸 안 하면 스크롤 계산이 전부 0 대 0 이라 **끌어도 아무 일도 안 일어나는 것을 통과시킨다.**
 */
const seedRail = (containerEl, view) => {
	const rail = gRail(containerEl);
	rail.clientWidth = G_RIGHT - G_LEFT;
	gRailTrack(containerEl).offsetWidth = Math.round(parseFloat(gRailTrack(containerEl).style.width || '0'));
	view.onDataUpdated();
	gRailTrack(containerEl).offsetWidth = Math.round(parseFloat(gRailTrack(containerEl).style.width || '0'));
};
/** 띠를 그 자리로 끈다 — 실물처럼 위치를 바꾸고 scroll 이벤트를 낸다. */
const scrollRail = (containerEl, at) => {
	const rail = gRail(containerEl);
	rail.scrollLeft = at;
	rail.dispatch('scroll');
};

async function graphTests() {
	console.log('\n[74] 그래프 — 등록·골격');
	resetStubs();
	{
		const { view, containerEl, registration } = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 55),
		]);

		check('뷰가 등록된다', !!registration);
		check('표시 이름에 Bases 단독이 없다', registration.name === 'Plus graph', registration.name);
		check('아이콘은 코어 선형 차트 글리프', registration.icon === 'line-chart', registration.icon);
		check('뷰 타입이 .base 계약 그대로', view.type === 'bases-plus-graph', view.type);
		check('is-loading 을 뗀다', !containerEl.hasClass('is-loading'));
		check('루트가 그래프 표식을 갖는다', containerEl.find('bases-plus-view').hasClass('is-graph'));

		const graphEl = containerEl.find('bases-plus-graph');
		const order = graphEl.children.map((el) => Array.from(el.classes)[0]);
		check('범례가 플롯 위에 온다', order.indexOf('bases-plus-graph-legend') < order.indexOf('bases-plus-graph-plot'), order.join('|'));
		check('안내 띠가 맨 위', order[0] === 'bases-plus-notice', order.join('|'));

		check('플롯은 SVG 캔버스를 갖는다', gCanvas(containerEl).svg === true && gCanvas(containerEl).tag === 'svg');
		check('격자·축·선이 캔버스 안', !!gCanvas(containerEl).find('bases-plus-graph-grid') && !!gCanvas(containerEl).find('bases-plus-graph-lines'));
		// 점은 HTML 이라야 옵시디언 툴팁이 뜬다 — 스텁이 SVG 툴팁을 거부하므로 이 줄이 회귀 감시선이다.
		check('점 층은 HTML 이다', containerEl.find('bases-plus-graph-dots').svg !== true);
		check('점도 HTML 이다', gDots(containerEl)[0].svg !== true);
		check('렌더 오류가 없다', containerEl.find('bases-plus-error').hidden);
		view.unload();
	}

	console.log('\n[75] 속성 미지정 — 빈 좌표축을 남기지 않는다 (D)');
	resetStubs();
	{
		const both = await mountGraph([gEntry('Note A', '2026-08-01', 40)], { xProperty: null, yProperties: null });
		check('안내 문구가 명세 그대로', gNotice(both.containerEl) === 'Choose an X and Y property to draw the graph.', String(gNotice(both.containerEl)));
		check('플롯을 그리지 않는다', both.containerEl.find('bases-plus-graph-plot').hidden);
		check('범례도 없다', both.containerEl.find('bases-plus-graph-legend').hidden);
		check('축도 안 그린다', gGridLines(both.containerEl).length === 0);
		both.view.unload();

		const onlyX = await mountGraph([gEntry('Note A', '2026-08-01', 40)], null, { properties: [] });
		check('표시 속성이 비어도 같은 안내', gNotice(onlyX.containerEl) === 'Choose an X and Y property to draw the graph.', String(gNotice(onlyX.containerEl)));
		onlyX.view.unload();
	}

	console.log('\n[76] 범례 — 이름(단위) · 선과 같은 색 변수 (C2·B2)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph(
			[gEntry('Note A', '2026-08-01', 40, 70), gEntry('Note B', '2026-08-05', 55, 62)],
			{ yUnits: ['만원', '명'] },
			GRAPH_TWO
		);

		const legend = gLegend(containerEl);
		check('시리즈마다 한 줄', legend.length === 2, String(legend.length));
		check('단위가 이름 뒤 괄호에 붙는다', legend[0].find('bases-plus-graph-legend-name').text === 'sales(만원)', legend[0].find('bases-plus-graph-legend-name').text);
		check('단위가 없으면 이름만', (await mountGraph([gEntry('Note A', '2026-08-01', 40)])).containerEl.find('bases-plus-graph-legend-name').text === 'sales');

		const swatches = containerEl.findAll('bases-plus-graph-swatch');
		const paths = gPaths(containerEl);
		check('첫 시리즈는 blue 자리', gColorOf(swatches[0]) === 'var(--bases-plus-series-1)', gColorOf(swatches[0]));
		check('둘째 시리즈는 orange 자리', gColorOf(swatches[1]) === 'var(--bases-plus-series-2)', gColorOf(swatches[1]));
		check('범례 점과 선이 같은 변수', gColorOf(swatches[0]) === gColorOf(paths[0]) && gColorOf(swatches[1]) === gColorOf(paths[1]));
		check('점도 같은 변수', gColorOf(gDots(containerEl)[0]) === gColorOf(paths[0]));
		view.unload();
	}

	console.log('\n[77] y 축 — 1·2·5 눈금 · 맨 위 눈금이 플롯 안 (B2·H)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 88),
			gEntry('Note C', '2026-08-09', 134),
		]);

		check('사람이 읽는 수로 떨어진다', gGridTexts(containerEl).join('|') === '0|50|100|150', gGridTexts(containerEl).join('|'));
		const ys = gGridLines(containerEl).map((el) => Number(el.attrs.y1));
		check('맨 위 눈금이 플롯 안에 있다(음수 좌표 0건)', ys.every((y) => y >= 0), ys.join('|'));
		check('맨 위 눈금이 위 여백 위에 선다', Math.min.apply(null, ys) === G_TOP, String(Math.min.apply(null, ys)));
		check('0 눈금이 축 선 자리', Math.max.apply(null, ys) === G_BOTTOM, String(Math.max.apply(null, ys)));
		check('격자가 플롯 폭을 가로지른다', gGridLines(containerEl).every((el) => Number(el.attrs.x1) === G_LEFT && Number(el.attrs.x2) === G_RIGHT));
		check('x 축 선이 바닥에 선다', Number(gAxisLine(containerEl).attrs.y1) === G_BOTTOM);

		// 최대값 134 가 맨 위 눈금(150)보다 아래에 있어야 점이 축 밖으로 안 나간다.
		const top = Math.min.apply(null, gDots(containerEl).map((el) => gDotAt(el).y));
		check('가장 큰 값도 맨 위 눈금 아래', top > G_TOP, String(top));
		view.unload();
	}

	console.log('\n[78] 값이 없는 구간 — 기본은 끊고, 고르면 잇는다 (확정 4·F1)');
	resetStubs();
	{
		const entries = [
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 55),
			gEntry('Note C', '2026-08-09', null, 80),
			gEntry('Note D', '2026-08-13', 88),
			gEntry('Note E', '2026-08-17', 96),
		];
		const broken = await mountGraph(entries);

		check('기본은 선이 끊어진다', gPaths(broken.containerEl).length === 2, String(gPaths(broken.containerEl).length));
		check('빈 자리에는 점이 없다', gDots(broken.containerEl).length === 4, String(gDots(broken.containerEl).length));
		broken.view.unload();

		const joined = await mountGraph(entries, { missingValues: 'connect' });
		check('Connect 면 한 조각', gPaths(joined.containerEl).length === 1, String(gPaths(joined.containerEl).length));
		check('이어도 없는 자리에 점은 안 찍는다', gDots(joined.containerEl).length === 4, String(gDots(joined.containerEl).length));
		joined.view.unload();

		// 끊긴 뒤 값이 하나뿐인 조각은 선이 아니라 점이다(D — "점이 하나뿐인 시리즈").
		const lonely = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 55),
			gEntry('Note C', '2026-08-09', null, 80),
			gEntry('Note D', '2026-08-13', 88),
		]);
		check('혼자 남은 값은 선 없이 점만', gPaths(lonely.containerEl).length === 1 && gDots(lonely.containerEl).length === 3, `${gPaths(lonely.containerEl).length}/${gDots(lonely.containerEl).length}`);
		lonely.view.unload();
	}

	console.log('\n[79] 숫자가 아닌 값 — 그 점만 건너뛰고 행은 버리지 않는다 (D)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph(
			[
				gEntry('Note A', '2026-08-01', 40, 70),
				gEntry('Note B', '2026-08-05', 55, 62),
				gEntry('Note C', '2026-08-09', '미정', 80),
				gEntry('Note D', '2026-08-13', 88, 85),
				gEntry('Note E', '2026-08-17', 96, 91),
			],
			null,
			GRAPH_TWO
		);

		const paths = gPaths(containerEl);
		const sales = paths.filter((el) => gColorOf(el) === 'var(--bases-plus-series-1)');
		const visits = paths.filter((el) => gColorOf(el) === 'var(--bases-plus-series-2)');
		check('숫자가 아닌 자리에서 그 시리즈만 끊긴다', sales.length === 2, String(sales.length));
		check('다른 시리즈는 그 행을 그대로 그린다', visits.length === 1 && gPoints(visits[0]).length === 5, String(gPoints(visits[0]).length));
		check('안내 띠를 세우지 않는다', gNotice(containerEl) === null, String(gNotice(containerEl)));
		view.unload();
	}

	console.log('\n[80] x 값이 없는 행 — 빠지고 개수를 알린다 (D)');
	resetStubs();
	{
		const one = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', null, 55),
		]);
		check('한 행이면 단수 문구', gNotice(one.containerEl) === '1 row has no X value and is not drawn.', String(gNotice(one.containerEl)));
		check('그 행은 점이 없다', gDots(one.containerEl).length === 1, String(gDots(one.containerEl).length));
		one.view.unload();

		const many = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', null, 55),
			gEntry('Note C', null, 60),
		]);
		check('여러 행이면 복수 문구', gNotice(many.containerEl) === '2 rows have no X value and are not drawn.', String(gNotice(many.containerEl)));
		many.view.unload();
	}

	console.log('\n[81] 모든 시리즈가 빈 값 — 축은 그리고 안내 띠 (D)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([gEntry('Note A', '2026-08-01'), gEntry('Note B', '2026-08-05')]);

		check('빈 화면을 남기지 않는다', gNotice(containerEl) === 'No numeric values to plot in the selected Y properties.', String(gNotice(containerEl)));
		check('축은 선다', gGridLines(containerEl).length > 0 && gAxisTexts(containerEl).length > 0);
		check('선도 점도 없다', gPaths(containerEl).length === 0 && gDots(containerEl).length === 0);
		check('범례도 비어 있다', gLegend(containerEl).length === 0);
		view.unload();
	}

	console.log('\n[82] x 오름차순 — 툴바 정렬과 무관하다 (B1)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([
			gEntry('Note C', '2026-08-09', 88),
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 55),
		]);

		const points = gPoints(gPaths(containerEl)[0]);
		check('선이 x 오름차순으로 이어진다', points[0][0] < points[1][0] && points[1][0] < points[2][0], points.map((p) => p[0]).join('|'));
		check('첫 점이 y 축 위에 선다', points[0][0] === G_LEFT, String(points[0][0]));
		check('마지막 점이 오른쪽 끝', points[2][0] === G_RIGHT, String(points[2][0]));
		check('가장 이른 날짜가 첫 점', gDots(containerEl)[0].tooltip.indexOf('2026-08-01') !== -1, gDots(containerEl)[0].tooltip);
		view.unload();
	}

	console.log('\n[83] 시간 비례 — 값의 간격이 화면 간격이 된다 (B1)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([
			gEntry('Note A', '2026-08-01', 10),
			gEntry('Note B', '2026-08-02', 20),
			gEntry('Note C', '2026-08-10', 30),
		]);

		const xs = gPoints(gPaths(containerEl)[0]).map((point) => point[0]);
		check('하루 간격이 여드레 간격보다 좁다', xs[1] - xs[0] < xs[2] - xs[1], xs.join('|'));
		check('간격 비가 날짜 비와 같다', Math.abs((xs[1] - xs[0]) / (xs[2] - xs[1]) - 1 / 8) < 0.01, String((xs[1] - xs[0]) / (xs[2] - xs[1])));
		view.unload();
	}

	console.log('\n[84] 날짜+시각 · 숫자 · 범주 x (B1·확정 5)');
	resetStubs();
	{
		const clock = await mountGraph([
			gEntry('Note A', '2026-08-01T09:00', 10),
			gEntry('Note B', '2026-08-01T12:00', 20),
			gEntry('Note C', '2026-08-01T21:00', 30),
		]);
		const clockXs = gPoints(gPaths(clock.containerEl)[0]).map((point) => point[0]);
		check('하루 안에서도 시각이 자리를 가른다', clockXs[0] < clockXs[1] && clockXs[1] < clockXs[2], clockXs.join('|'));
		check('시각 축은 눈금도 시각', /\d/.test(gAxisTexts(clock.containerEl)[0]) && gAxisTexts(clock.containerEl)[0].indexOf(':') !== -1, gAxisTexts(clock.containerEl).join('|'));
		clock.view.unload();

		const numeric = await mountGraph(
			[gEntry('Note A', 1, 10), gEntry('Note B', 2, 20), gEntry('Note C', 10, 30)],
			{ xProperty: 'note.date' }
		);
		const numXs = gPoints(gPaths(numeric.containerEl)[0]).map((point) => point[0]);
		check('숫자 x 는 값 비례', numXs[1] - numXs[0] < numXs[2] - numXs[1], numXs.join('|'));
		numeric.view.unload();

		const category = await mountGraph([
			gEntry('Note A', '진행중', 10),
			gEntry('Note B', '대기', 20),
			gEntry('Note C', '완료', 30),
		]);
		const catXs = gPoints(gPaths(category.containerEl)[0]).map((point) => point[0]);
		check('범주는 균등 배치', Math.abs((catXs[1] - catXs[0]) - (catXs[2] - catXs[1])) < 0.5, catXs.join('|'));
		check('등장 순서대로 선다', gAxisTexts(category.containerEl).join('|') === '진행중|대기|완료', gAxisTexts(category.containerEl).join('|'));
		category.view.unload();
	}

	console.log('\n[85] 아홉째 시리즈 — 색은 첫째와 같고 선이 파선 (C2·H)');
	resetStubs();
	{
		const values = { 'file.file': fileValue('Note A'), 'note.date': dateValue('2026-08-01') };
		const values2 = { 'file.file': fileValue('Note B'), 'note.date': dateValue('2026-08-05') };
		const keys = [];
		for (let i = 1; i <= 9; i++) {
			keys.push(`note.y${i}`);
			values[`note.y${i}`] = numberValue(i * 10);
			values2[`note.y${i}`] = numberValue(i * 10 + 5);
		}

		const { view, containerEl } = await mountGraph([makeEntry('Note A', values), makeEntry('Note B', values2)], null, {
			properties: ['note.date'].concat(keys),
		});

		const paths = gPaths(containerEl);
		check('시리즈 아홉 줄이 선다', paths.length === 9, String(paths.length));
		check('아홉째 색이 첫째와 같다', gColorOf(paths[8]) === gColorOf(paths[0]), `${gColorOf(paths[8])} vs ${gColorOf(paths[0])}`);
		check('아홉째만 파선', paths[8].hasClass('is-dashed') && !paths[0].hasClass('is-dashed'));
		check('범례 표식도 파선 모양', containerEl.findAll('bases-plus-graph-swatch')[8].hasClass('is-dashed'));
		check('여덟째까지는 팔레트 순서', gColorOf(paths[7]) === 'var(--bases-plus-series-8)', gColorOf(paths[7]));
		view.unload();
	}

	console.log('\n[86] 값 툴팁 — 옵시디언 툴팁에 한 줄 (C3)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph(
			[gEntry('Note A', '2026-08-01', 40, 70), gEntry('Note B', '2026-08-05', 55, 62)],
			{ yUnits: ['만원', '명'] },
			GRAPH_TWO
		);

		const dots = gDots(containerEl);
		check('문구는 이름 · x값 · y값(단위)', dots[0].tooltip === 'Note A · 2026-08-01 · sales 40만원', dots[0].tooltip);
		check('다른 시리즈는 그 이름·단위', dots[2].tooltip === 'Note A · 2026-08-01 · visits 70명', dots[2].tooltip);
		check('우리가 툴팁 요소를 그리지 않는다', containerEl.find('tooltip') === null);
		view.unload();
	}

	console.log('\n[87] 점 클릭·우클릭 — 확정분 열기 계층 그대로 (E)');
	resetStubs();
	{
		const { view, containerEl, opened } = await mountGraph([gEntry('Note A', '2026-08-01', 40)]);
		const dot = gDots(containerEl)[0];

		dot.dispatch('click');
		await wait();
		check('점을 누르면 기본 방식(모달)으로 연다', Modal.instances.length === 1, String(Modal.instances.length));

		dot.dispatch('contextmenu');
		check('우클릭 메뉴가 뜬다', Menu.instances.length === 1);
		check('열기 항목 문구가 확정분과 같다', Menu.instances[0].items[0].title === 'Open with Bases Plus', String(Menu.instances[0].items[0].title));

		Modal.instances.length = 0;
		dot.dispatch('click', { metaKey: true });
		await wait();
		check('수식어 클릭은 코어에 넘긴다', Modal.instances.length === 0);
		view.unload();
	}

	console.log('\n[88] 점 표시 — Auto 는 뭉치면 솎고 감춘다 (확정 3)');
	resetStubs();
	{
		const sparse = await mountGraph([
			gEntry('Note A', '2026-08-01', 10),
			gEntry('Note B', '2026-08-05', 20),
			gEntry('Note C', '2026-08-09', 30),
		]);
		check('점이 성기면 그대로 보인다', !sparse.containerEl.find('bases-plus-graph-dots').hasClass('is-hover-only'));
		check('점을 다 그린다', gDots(sparse.containerEl).length === 3);
		sparse.view.unload();

		// 200 행이면 점 사이가 3px 이라 지름 6px 보다 좁다 — 솎이는 자리다.
		const many = [];
		for (let i = 0; i < 200; i++) many.push(gEntry(`Note ${i}`, `2026-08-01T${String(Math.floor(i / 10)).padStart(2, '0')}:${String((i % 10) * 6).padStart(2, '0')}`, i));
		const dense = await mountGraph(many);
		check('뭉치면 점을 솎는다', gDots(dense.containerEl).length < 200 && gDots(dense.containerEl).length > 0, String(gDots(dense.containerEl).length));
		check('솎은 점 사이가 지름 이상', gDots(dense.containerEl).map(gDotAt).every((at, i, all) => i === 0 || at.x - all[i - 1].x >= 6 - 0.01));
		check('Auto 는 그때 선만 남긴다', dense.containerEl.find('bases-plus-graph-dots').hasClass('is-hover-only'));
		check('선은 모든 값을 그대로 지난다', gPoints(gPaths(dense.containerEl)[0]).length === 200, String(gPoints(gPaths(dense.containerEl)[0]).length));
		dense.view.unload();

		const always = await mountGraph(many, { showDots: 'always' });
		check('Always 면 뭉쳐도 보인다', !always.containerEl.find('bases-plus-graph-dots').hasClass('is-hover-only'));
		always.view.unload();

		const hover = await mountGraph([gEntry('Note A', '2026-08-01', 10), gEntry('Note B', '2026-08-05', 20)], { showDots: 'hover' });
		check('On hover 면 성겨도 감춘다', hover.containerEl.find('bases-plus-graph-dots').hasClass('is-hover-only'));
		hover.view.unload();
	}

	console.log('\n[89] 폭이 좁아지면 눈금 개수가 준다 (B1·A3)');
	resetStubs();
	{
		const wide = await mountGraph(
			[gEntry('Note A', '2026-08-01', 10), gEntry('Note B', '2026-09-20', 20)],
			null,
			{ width: 900 }
		);
		const narrow = await mountGraph(
			[gEntry('Note A', '2026-08-01', 10), gEntry('Note B', '2026-09-20', 20)],
			null,
			{ width: 220 }
		);

		check('좁으면 눈금이 적다', gAxisTexts(narrow.containerEl).length < gAxisTexts(wide.containerEl).length, `${gAxisTexts(narrow.containerEl).length} < ${gAxisTexts(wide.containerEl).length}`);
		check('좁아도 최소 둘은 남는다', gAxisTexts(narrow.containerEl).length >= 2, String(gAxisTexts(narrow.containerEl).length));
		check('선이 좁은 폭 안에서 끝난다', gPoints(gPaths(narrow.containerEl)[0]).every((point) => point[0] <= 220 - 8 + 0.01));
		wide.view.unload();
		narrow.view.unload();
	}

	console.log('\n[90] 갱신 — 점 요소를 재사용한다 (성2)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', '2026-08-05', 55),
		]);

		const firstDot = gDots(containerEl)[0];
		const listeners = firstDot.listeners.length;
		const nodes = containerEl.countNodes();

		view.onDataUpdated();
		view.onDataUpdated();

		check('점 요소를 재사용한다', gDots(containerEl)[0] === firstDot);
		check('갱신해도 노드가 늘지 않는다', containerEl.countNodes() === nodes, `${nodes} -> ${containerEl.countNodes()}`);
		check('갱신해도 리스너가 누적되지 않는다', firstDot.listeners.length === listeners, `${listeners} -> ${firstDot.listeners.length}`);

		// 행이 줄면 남는 점은 감춰지고 다시 늘면 그 자리를 다시 쓴다.
		view.data = new BasesQueryResult([gEntry('Note A', '2026-08-01', 40)], GRAPH_PROPS);
		view.onDataUpdated();
		check('줄어든 점은 감춘다', gDots(containerEl).length === 1, String(gDots(containerEl).length));
		check('감춘 점 요소는 남겨 둔다', containerEl.findAll('bases-plus-graph-dot').length === 2);

		view.unload();
		check('뷰 루트를 컨테이너에서 뗀다', containerEl.find('bases-plus-view') === null);
		check('점 리스너를 푼다', firstDot.listeners.length === 0);
	}

	console.log('\n[91] 뷰 옵션 — 순서·키·기본값 (F)');
	resetStubs();
	{
		const { view, registration, config } = await mountGraph([gEntry('Note A', '2026-08-01', 40)]);
		const options = registration.options(config);

		check('여섯 줄', options.length === 6, String(options.length));
		check('순서가 명세 그대로', options.map((o) => o.key).join('|') === 'xProperty|xWindow|yUnits|showDots|missingValues|openMode', options.map((o) => o.key).join('|'));
		check('이름이 명세 그대로', options.map((o) => o.displayName).join('|') === 'X property|X window|Units|Show dots|Missing values|Open points with', options.map((o) => o.displayName).join('|'));
		// y 속성 목록 옵션은 네이티브 속성 설정으로 대체됐다(마스터 요청 0812) — 손으로 적는 자리가 없어야 한다.
		check('y 속성 옵션이 없다', options.every((o) => o.key !== 'yProperties'), options.map((o) => o.key).join('|'));
		// 창은 값을 넣어야 생긴다 — 비면 전체라 지금까지의 화면 그대로다(골격 규약: 기본 = 현행).
		check('창 옵션은 한 칸짜리 값', options[1].type === 'text' && options[1].placeholder === 'All', String(options[1].placeholder));
		check('Units 는 한 줄에 하나', options[2].type === 'multitext');
		check('Show dots 기본은 Auto', options[3].default === 'auto' && Object.keys(options[3].options).join('|') === 'always|hover|auto');
		check('Missing values 기본은 Break line', options[4].default === 'break' && options[4].options.break === 'Break line');
		check('열기 방식은 표·달력과 같은 키', options[5].key === 'openMode' && options[5].default === 'modal');
		view.unload();
	}

	console.log('\n[92] 렌더가 실패해도 루트를 지우지 않는다 (임베드 함정 B)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([gEntry('Note A', '2026-08-01', 40)]);

		/*
		 * **결과 객체의 형상을 지킨 채** 값 읽기만 터뜨린다. 평범한 객체로 갈아 끼우면 `properties` 게터가
		 * 사라져 뷰가 "표시 속성이 없다"로 빠지고 오류 경로를 아예 안 탄다(시리즈 출처가 그 목록이라 그렇다).
		 */
		const broken = new BasesQueryResult([], GRAPH_PROPS);
		Object.defineProperty(broken, 'data', { get() { throw new Error('boom'); } });
		view.data = broken;
		view.onDataUpdated();

		check('루트가 남는다', !!containerEl.find('bases-plus-view'));
		check('오류 줄이 뜬다', !containerEl.find('bases-plus-error').hidden);
		check('문구가 확정분과 같다', containerEl.find('bases-plus-error').text === 'Bases Plus could not render this view. Open the developer console for the reason.');
		view.unload();
	}

	console.log('\n[93] 툴팁 — 사실상 즉시 · 점 위 (마스터 1·2차 실기동 코멘트)');
	resetStubs();
	{
		const { view, containerEl } = await mountGraph([gEntry('Note A', '2026-08-01', 40)]);
		const dot = gDots(containerEl)[0];

		/*
		 * 실물 `setTooltip` 은 옵션을 `data-*` 로 심는다(app.js `Yg`) — 코어가 hover 때 그 자리를 다시 읽는다.
		 *
		 * **0 을 넣으면 안 된다.** 코어는 참일 때만 속성을 쓰고 속성이 없으면 기본 1000ms 를 읽으므로,
		 * `delay: 0` 은 "제일 빠르게" 가 아니라 조용히 "제일 느리게" 가 된다. 그래서 속성의 **존재**부터 잰다.
		 */
		check('지연 속성이 실제로 심긴다', typeof dot.attrs['data-tooltip-delay'] === 'string' && dot.attrs['data-tooltip-delay'] !== '', String(dot.attrs['data-tooltip-delay']));
		check('사실상 즉시다', Number(dot.attrs['data-tooltip-delay']) > 0 && Number(dot.attrs['data-tooltip-delay']) <= 1, String(dot.attrs['data-tooltip-delay']));
		check('코어 기본(1000ms)보다 빠르다', Number(dot.attrs['data-tooltip-delay']) < 1000);
		// 기본 자리는 아래(bottom)라 마우스 포인터가 값을 가린다 — 위로 올린다(마스터 2차 실기동).
		check('점 위에 뜬다', dot.attrs['data-tooltip-position'] === 'top', String(dot.attrs['data-tooltip-position']));
		check('문구는 그대로다', dot.attrs['aria-label'] === dot.tooltip && dot.tooltip.indexOf('Note A') === 0, String(dot.tooltip));
		view.unload();
	}

	console.log('\n[94] 범례 클릭 — 시리즈 감추기·되살리기 (마스터 요청 0812)');
	resetStubs();
	{
		const { view, containerEl, config } = await mountGraph(
			[
				gEntry('Note A', '2026-08-01', 200, 20),
				gEntry('Note B', '2026-08-05', 900, 30),
				gEntry('Note C', '2026-08-09', 400, 25),
			],
			null,
			GRAPH_TWO
		);

		const legend = gLegend(containerEl);
		const storedKeys = Object.keys(config.stored).join('|');
		check('범례 줄이 누를 수 있는 것이다', legend[0].tag === 'button' && legend[0].attrs.type === 'button');
		check('켜져 있음이 표식으로 남는다', legend[0].attrs['aria-pressed'] === 'true');
		check('두 시리즈가 다 그려져 있다', gPaths(containerEl).length === 2 && gGridTexts(containerEl).join('|') === '0|500|1,000', gGridTexts(containerEl).join('|'));

		legend[0].dispatch('click');

		check('감춘 시리즈는 선이 사라진다', gPaths(containerEl).length === 1, String(gPaths(containerEl).length));
		check('남은 선은 다른 시리즈다', gColorOf(gPaths(containerEl)[0]) === 'var(--bases-plus-series-2)', gColorOf(gPaths(containerEl)[0]));
		check('감춘 시리즈의 점도 사라진다', gDots(containerEl).length === 3, String(gDots(containerEl).length));
		check('범례 줄은 남는다', gLegend(containerEl).length === 2, String(gLegend(containerEl).length));
		check('감춘 줄이 흐려진다', legend[0].hasClass('is-off') && !legend[1].hasClass('is-off'));
		check('꺼져 있음이 표식으로 남는다', legend[0].attrs['aria-pressed'] === 'false');
		check('되살릴 수 있다고 말한다', String(legend[0].attrs['aria-label']).indexOf('Show ') === 0, String(legend[0].attrs['aria-label']));
		// 감추는 이유가 "큰 값이 작은 값을 눌렀다" 는 것이라(확정 2) 축이 비켜 주지 않으면 감춘 보람이 없다.
		check('y 축을 다시 계산한다', gGridTexts(containerEl).join('|') === '0|10|20|30', gGridTexts(containerEl).join('|'));
		check('저장하지 않는다', Object.keys(config.stored).join('|') === storedKeys, Object.keys(config.stored).join('|'));

		// 갱신은 감춤을 풀지 않는다 — 볼트가 바뀔 때마다 되살아나면 감추기가 쓸모없다.
		view.onDataUpdated();
		check('갱신을 넘어 감춤이 남는다', gPaths(containerEl).length === 1 && gLegend(containerEl)[0].hasClass('is-off'));

		gLegend(containerEl)[0].dispatch('click');
		check('다시 누르면 돌아온다', gPaths(containerEl).length === 2, String(gPaths(containerEl).length));
		check('색도 그대로다', gColorOf(gPaths(containerEl)[0]) === 'var(--bases-plus-series-1)', gColorOf(gPaths(containerEl)[0]));
		check('축도 돌아온다', gGridTexts(containerEl).join('|') === '0|500|1,000', gGridTexts(containerEl).join('|'));

		// 다 감춰도 범례는 남아야 되살릴 자리가 있다.
		gLegend(containerEl)[0].dispatch('click');
		gLegend(containerEl)[1].dispatch('click');
		check('전부 감춰도 범례가 남는다', gLegend(containerEl).length === 2);
		check('전부 감추면 축만 남는다', gPaths(containerEl).length === 0 && gGridLines(containerEl).length > 0);

		const listeners = legend[0].listeners.length;
		view.unload();
		check('범례 리스너를 푼다', legend[0].listeners.length === 0, `${listeners} -> ${legend[0].listeners.length}`);
	}

	console.log('\n[95] 시리즈 출처는 네이티브 속성 설정이다 (마스터 요청 0812)');
	resetStubs();
	{
		const entries = [gEntry('Note A', '2026-08-01', 40, 70), gEntry('Note B', '2026-08-05', 55, 62)];
		const one = await mountGraph(entries);
		check('표시 속성의 숫자 속성이 시리즈가 된다', gLegend(one.containerEl).length === 1 && gLegend(one.containerEl)[0].find('bases-plus-graph-legend-name').text === 'sales', String(gLegend(one.containerEl).length));

		// 같은 데이터에 속성 하나를 더 보이면 시리즈가 는다 — 툴바 Properties 메뉴가 하는 일이 이것이다.
		one.view.data = new BasesQueryResult(entries, GRAPH_TWO.properties);
		one.view.onDataUpdated();
		check('속성을 더 보이면 시리즈가 는다', gLegend(one.containerEl).length === 2, String(gLegend(one.containerEl).length));
		check('숫자가 아닌 속성은 빠진다', gLegend(one.containerEl).every((el) => el.find('bases-plus-graph-legend-name').text !== 'name'));
		// 이름 열이 앞에 있어도 **첫 선은 파랑**이다 — 색은 목록 자리가 아니라 그리는 순서로 매긴다.
		check('첫 선이 팔레트 첫 색', gColorOf(gPaths(one.containerEl)[0]) === 'var(--bases-plus-series-1)', gColorOf(gPaths(one.containerEl)[0]));

		// x 속성은 목록에 늘 있지만 시리즈가 되면 안 된다 — 가로축 값이 세로축에도 서면 무의미한 선이 하나 생긴다.
		check('x 속성은 시리즈가 아니다', gLegend(one.containerEl).every((el) => el.find('bases-plus-graph-legend-name').text !== 'date'), gLegend(one.containerEl).map((el) => el.find('bases-plus-graph-legend-name').text).join('|'));
		one.view.unload();

		// 예전 저장값은 아무 일도 하지 않는다 — 손으로 적던 목록이 화면을 다시 흔들지 않게.
		const legacy = await mountGraph(entries, { yProperties: ['note.visits'] });
		check('저장된 yProperties 는 무시된다', gLegend(legacy.containerEl).length === 1 && gLegend(legacy.containerEl)[0].find('bases-plus-graph-legend-name').text === 'sales', gLegend(legacy.containerEl).map((el) => el.find('bases-plus-graph-legend-name').text).join('|'));
		legacy.view.unload();

		/*
		 * `.base` 의 속성 목록은 노트 속성을 **접두사 없이** 적는다(Demo.base 실물: `시작`·`status`).
		 * 그 형태가 그대로 넘어와도 x 는 시리즈가 되면 안 된다 — 안 그러면 가로축 값이 세로축에도 선다.
		 */
		const bare = await mountGraph(entries, null, { properties: ['file.name', '날짜', 'sales'] });
		check('접두사 없는 목록에서도 x 를 뺀다', gLegend(bare.containerEl).every((el) => el.find('bases-plus-graph-legend-name').text !== '날짜'), gLegend(bare.containerEl).map((el) => el.find('bases-plus-graph-legend-name').text).join('|'));
		bare.view.unload();

		// 단위는 **그리는 시리즈와 같은 순서**다(F) — 목록 자리가 아니라 그리는 자리에 붙는다.
		const units = await mountGraph(entries, { yUnits: ['만원', '명'] }, GRAPH_TWO);
		check('단위가 그리는 순서대로 붙는다', gLegend(units.containerEl).map((el) => el.find('bases-plus-graph-legend-name').text).join('|') === 'sales(만원)|visits(명)', gLegend(units.containerEl).map((el) => el.find('bases-plus-graph-legend-name').text).join('|'));
		units.view.unload();
	}

	console.log('\n[96] x 창 — 보이는 구간을 잡고 스크롤로 옮긴다 (마스터 요청 0812 · 골격)');
	resetStubs();
	{
		// 8/1 부터 닷새 간격 다섯 점 = 스무 날 구간. 창을 열흘로 잡으면 절반만 보인다.
		const spread = [
			gEntry('Note A', '2026-08-01', 10),
			gEntry('Note B', '2026-08-06', 20),
			gEntry('Note C', '2026-08-11', 30),
			gEntry('Note D', '2026-08-16', 40),
			gEntry('Note E', '2026-08-21', 50),
		];

		// 대조군 — 창을 안 잡으면 지금까지의 화면 그대로다(골격 규약: 기본 = 현행).
		const all = await mountGraph(spread);
		check('기본은 전체다', gDots(all.containerEl).length === 5, String(gDots(all.containerEl).length));
		check('띠가 없다', gRail(all.containerEl).hidden);
		const allPoints = gPoints(gPaths(all.containerEl)[0]);
		check('첫 점이 y 축 위, 마지막 점이 오른쪽 끝', allPoints[0][0] === G_LEFT && allPoints[4][0] === G_RIGHT, `${allPoints[0][0]}|${allPoints[4][0]}`);
		all.view.unload();

		const win = await mountGraph(spread, { xWindow: '10' });
		seedRail(win.containerEl, win.view);

		// 창은 처음에 **오른쪽 끝**에 붙는다 — 날짜 축에서 사람이 먼저 보는 것은 최근이다.
		check('창 밖의 점은 안 그린다', gDots(win.containerEl).length === 3, String(gDots(win.containerEl).length));
		check('보이는 것이 최근 쪽이다', gDots(win.containerEl)[0].tooltip.indexOf('2026-08-11') !== -1, gDots(win.containerEl)[0].tooltip);
		check('마지막 값이 오른쪽 끝에 선다', gPoints(gPaths(win.containerEl)[0]).slice(-1)[0][0] === G_RIGHT);
		// 선은 경계에서 잘린다 — 창 밖으로 뻗으면 y 눈금 글자와 뷰 바깥까지 덧칠한다.
		check('선이 창 왼쪽 경계에서 시작한다', gPoints(gPaths(win.containerEl)[0])[0][0] === G_LEFT, String(gPoints(gPaths(win.containerEl)[0])[0][0]));
		check('축 눈금도 창 구간이다', gAxisTexts(win.containerEl)[0] === '8/11', gAxisTexts(win.containerEl).join('|'));

		// 띠 — 안쪽 폭이 `플롯 폭 × (전체 / 창)` 이라 손잡이 길이가 곧 "얼마를 보고 있나" 가 된다.
		check('띠가 선다', !gRail(win.containerEl).hidden);
		check('띠 폭이 전체 대 창의 비다', Math.round(parseFloat(gRailTrack(win.containerEl).style.width)) === (G_RIGHT - G_LEFT) * 2, `${gRailTrack(win.containerEl).style.width} vs ${(G_RIGHT - G_LEFT) * 2}`);

		const beforeTicks = gGridTexts(win.containerEl).join('|');

		// 띠를 왼쪽 끝까지 끌면 가장 이른 구간이 보인다.
		scrollRail(win.containerEl, 0);
		check('끌면 창이 옮겨진다', gDots(win.containerEl)[0].tooltip.indexOf('2026-08-01') !== -1, gDots(win.containerEl)[0].tooltip);
		check('그쪽 창 밖도 안 그린다', gDots(win.containerEl).length === 3, String(gDots(win.containerEl).length));
		check('선이 오른쪽 경계에서 끝난다', gPoints(gPaths(win.containerEl)[0]).slice(-1)[0][0] === G_RIGHT);
		// 스크롤 중에 축이 뛰면 어디를 보고 있는지 놓친다 — y 는 전체 값으로 고정이다(골격 판단).
		check('스크롤해도 y 축은 그대로다', gGridTexts(win.containerEl).join('|') === beforeTicks, `${beforeTicks} -> ${gGridTexts(win.containerEl).join('|')}`);
		check('창 자리를 저장하지 않는다', win.config.stored.xWindow === '10' && Object.keys(win.config.stored).indexOf('xWindowAt') === -1, Object.keys(win.config.stored).join('|'));

		// Shift+휠도 같은 조작이다 — 가로 뜻이 분명할 때만 가로챈다.
		const wheel = win.containerEl.find('bases-plus-graph-plot').dispatch('wheel', { deltaY: 600, deltaX: 0, shiftKey: true, preventDefault() { this.defaultPrevented = true; } });
		check('Shift+휠이 창을 옮긴다', gDots(win.containerEl)[0].tooltip.indexOf('2026-08-01') === -1, gDots(win.containerEl)[0].tooltip);
		check('그때만 기본 스크롤을 막는다', wheel.defaultPrevented === true);

		const plain = win.containerEl.find('bases-plus-graph-plot').dispatch('wheel', { deltaY: 600, deltaX: 0, shiftKey: false, preventDefault() { this.defaultPrevented = true; } });
		check('세로 휠은 그대로 넘긴다', plain.defaultPrevented === false);
		win.view.unload();
	}

	console.log('\n[97] x 창 — 안 걸리는 자리 (범주형·이상한 값·데이터보다 넓은 창)');
	resetStubs();
	{
		const category = await mountGraph(
			[gEntry('Note A', '진행중', 10), gEntry('Note B', '대기', 20), gEntry('Note C', '완료', 30)],
			{ xWindow: '1' }
		);
		// 범주 축은 칸 수가 곧 폭이라 자를 자리가 없다.
		check('범주형은 창을 무시한다', gDots(category.containerEl).length === 3 && gRail(category.containerEl).hidden, String(gDots(category.containerEl).length));
		category.view.unload();

		const entries = [gEntry('Note A', '2026-08-01', 10), gEntry('Note B', '2026-08-21', 50)];

		for (const value of ['', '0', '-5', 'abc']) {
			const odd = await mountGraph(entries, { xWindow: value });
			check(`이상한 값(${value || '빈칸'})이면 전체다`, gDots(odd.containerEl).length === 2 && gRail(odd.containerEl).hidden, String(gDots(odd.containerEl).length));
			odd.view.unload();
		}

		// 창이 데이터보다 넓으면 움직일 것이 없다 — 띠를 세우지 않는다.
		const wide = await mountGraph(entries, { xWindow: '100' });
		check('창이 데이터보다 넓으면 전체다', gDots(wide.containerEl).length === 2, String(gDots(wide.containerEl).length));
		check('그때는 띠도 없다', gRail(wide.containerEl).hidden);
		wide.view.unload();

		// 속성을 지우면 플롯이 사라진다 — 띠만 남으면 아무 데도 닿지 않는 컨트롤이 선다.
		const dropped = await mountGraph(
			[gEntry('Note A', '2026-08-01', 10), gEntry('Note B', '2026-08-21', 50)],
			{ xWindow: '5' }
		);
		check('창을 잡으면 띠가 있다', !gRail(dropped.containerEl).hidden);
		dropped.view.data = new BasesQueryResult([], []);
		dropped.view.onDataUpdated();
		check('플롯이 없어지면 띠도 없어진다', gRail(dropped.containerEl).hidden);
		dropped.view.unload();

		// 숫자 x 는 단위가 **값 폭**이다 — 날짜의 "일" 과 같은 자리에서 축 종류가 뜻을 정한다.
		const numeric = await mountGraph(
			[gEntry('Note A', 0, 10), gEntry('Note B', 50, 20), gEntry('Note C', 100, 30)],
			{ xWindow: '40' }
		);
		check('숫자 x 도 창이 걸린다', !gRail(numeric.containerEl).hidden && gDots(numeric.containerEl).length < 3, String(gDots(numeric.containerEl).length));
		numeric.view.unload();
	}
}

// ── 한글화 (i18n) ───────────────────────────────────────────────────────────────
const SRC_DIR = require('path').join(__dirname, '..', 'src');

/** `src` 아래 모든 `.ts` 를 읽는다 — 사전과 호출부를 소스에서 직접 대조한다. */
function srcFiles(dir) {
	const fs = require('fs');
	const path = require('path');
	const out = [];
	for (const name of fs.readdirSync(dir || SRC_DIR)) {
		const at = path.join(dir || SRC_DIR, name);
		if (fs.statSync(at).isDirectory()) out.push(...srcFiles(at));
		else if (name.endsWith('.ts')) out.push(at);
	}
	return out;
}

const readSrc = (file) => require('fs').readFileSync(file, 'utf8');
const QUOTED = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

/** `t(...)` 에 넘긴 원문들. 삼항(`t(a ? 'A' : 'B')`)도 양쪽을 다 걷는다. */
function translatedLiterals(text) {
	const out = [];
	const calls = /(^|[^A-Za-z0-9_$.])t\(([^)]{0,400}?)\)/g;
	let call;
	while ((call = calls.exec(text)) !== null) {
		let quoted;
		QUOTED.lastIndex = 0;
		while ((quoted = QUOTED.exec(call[2])) !== null) out.push(quoted[1] !== undefined ? quoted[1] : quoted[2]);
	}
	return out;
}

/** 사전에 실린 원문 키. `'긴 키': 값` 과 `Key: 값` 두 형태를 다 읽는다. */
function dictionaryKeys() {
	const text = readSrc(require('path').join(SRC_DIR, 'shared', 'i18n.ts'));
	const block = text.slice(text.indexOf('const KO: Record<string, string> = {'), text.indexOf('\nDICTIONARIES.ko = KO;'));
	const keys = [];
	for (const line of block.split('\n')) {
		const match = /^\t(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z][A-Za-z0-9]*)):/.exec(line);
		if (match) keys.push((match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]).replace(/\\'/g, "'"));
	}
	return keys;
}

async function i18nTests() {
	console.log('\n[98] 한글화 — 사전 커버리지 (소스 대조)');
	resetStubs();
	{
		const files = srcFiles();
		const keys = dictionaryKeys();
		const sources = files.map(readSrc);
		const all = sources.join('\n');

		check('사전이 실려 있다', keys.length > 80, String(keys.length));

		// ① 옮기라고 부른 원문은 전부 사전에 있어야 한다 — 없으면 그 자리만 조용히 영어로 남는다.
		const missing = [];
		files.forEach((file, index) => {
			for (const literal of translatedLiterals(sources[index])) {
				if (keys.indexOf(literal) === -1) missing.push(`${require('path').basename(file)}: ${literal}`);
			}
		});
		check('사전에 없는 원문 0건', missing.length === 0, missing.slice(0, 4).join(' | '));

		/*
		 * ② 죽은 사전 항목 0건. 선택지·안내처럼 **변수를 거쳐 옮겨지는 원문**은 ①이 못 잡는데,
		 * 이 검사가 그 자리를 대신 지킨다 — 사전 키의 글자가 소스와 한 자라도 다르면 여기서 걸린다.
		 */
		const dead = keys.filter((key) => all.indexOf(key) === -1);
		check('소스에 없는 사전 항목 0건', dead.length === 0, dead.slice(0, 4).join(' | '));

		/*
		 * ③ **빠뜨린 문구 0건.** ①은 옮기라고 부른 자리만 본다 — 새 문구를 쓰면서 `t()` 를 아예 안 부르면
		 * ①·②가 못 잡는다(실제로 모달 안내 한 줄이 그렇게 남아 있었다). 화면에 글자를 붙이는 자리에
		 * 영어 원문이 바로 들어가 있으면 여기서 걸린다.
		 */
		const SINKS = /(?:\btext:|\.setText\(|'aria-label':|\.setName\(|\.setDesc\(|\.setTitle\(|new Notice\(|\bdisplayName:|\bplaceholder:)\s*('((?:[^'\\]|\\.)*)')/g;
		const bare = [];
		files.forEach((file, index) => {
			let hit;
			SINKS.lastIndex = 0;
			while ((hit = SINKS.exec(sources[index])) !== null) {
				// 글자가 없는 값(기호·빈 문자열)은 옮길 것이 없다.
				// 아이콘 이름은 화면 글자가 아니다 — 속성 유형 표의 `text: 'lucide-text'` 가 그 자리다.
				if (/[A-Za-z]/.test(hit[2]) && hit[2].indexOf('lucide-') !== 0) bare.push(`${require('path').basename(file)}: ${hit[2].slice(0, 40)}`);
			}
		});
		check('옮기지 않고 박아 넣은 문구 0건', bare.length === 0, bare.slice(0, 4).join(' | '));

		// ④ 저장 값은 번역하지 않는다 — 사전에 실린 것은 화면 글자뿐이어야 한다.
		const storedValues = ['always', 'hover', 'auto', 'break', 'connect', 'month', 'week', 'names', 'values', 'modal', 'tab', 'window', 'pages', 'group-top', 'group-pages'];
		check('저장 값이 사전에 없다', storedValues.every((value) => keys.indexOf(value) === -1));
	}

	console.log('\n[99] 한글화 — 한국어 화면 (표본 렌더)');
	resetStubs();
	{
		stub.setLanguage('ko');

		const { app } = makeApp('visible');
		const table = await mount(app, [makeEntry('Note A')]);
		const options = table.registration.options(table.config);
		const names = options.map((option) => option.displayName);

		check('뷰 이름이 한글이다', table.registration.name === '플러스 표', table.registration.name);
		check('뷰 옵션 이름이 한글이다', names.join('|') === '행 열기 방식|행 제한|페이지당 행 수|그룹당 행 수|수동 순서|그룹 수동 순서', names.join('|'));

		const rowLimit = options.find((option) => option.key === 'rowLimit');
		check('선택지 글자가 한글이다', rowLimit.options.all === '모두 표시하기' && rowLimit.options.pages === '페이지', JSON.stringify(rowLimit.options));
		// **저장 값은 그대로다** — 키를 번역하면 언어를 바꾼 순간 `.base` 설정이 깨진다.
		check('선택지 키는 영어 그대로다', Object.keys(rowLimit.options).join('|') === 'all|pages|group-top|group-pages', Object.keys(rowLimit.options).join('|'));

		const openMode = options.find((option) => option.key === 'openMode');
		check('열기 방식도 한글이다', openMode.options.modal === '모달' && openMode.options.tab === '새 탭', JSON.stringify(openMode.options));
		table.view.unload();
	}

	console.log('\n[100] 한글화 — 뷰별 문구·안내 띠·페이저');
	resetStubs();
	{
		stub.setLanguage('ko');

		// 안내 띠 — 문구를 만드는 층은 계산 전용이라 화면에 붙는 자리에서 옮겨진다.
		const timeline = await mountTimeline([tlEntry('Note A', null)], { startDate: null });
		check('타임라인 안내 띠가 한글이다', timeline.containerEl.find('bases-plus-notice').text === '타임라인을 그리려면 시작 날짜 속성을 정하세요.', timeline.containerEl.find('bases-plus-notice').text);
		check('타임라인 도구가 한글이다', timeline.containerEl.findAll('bases-plus-tl-tool')[0].attrs['aria-label'] === '축소', String(timeline.containerEl.findAll('bases-plus-tl-tool')[0].attrs['aria-label']));
		timeline.view.unload();

		const calendar = await mountCalendar([calEntry('Note A', isoOf(dayOfMonth(10)))], { startDate: null });
		check('달력 안내 띠가 한글이다', calendar.containerEl.find('bases-plus-notice').text === '달력을 그리려면 시작 날짜 속성을 정하세요.', calendar.containerEl.find('bases-plus-notice').text);
		check('달력 오늘 버튼이 한글이다', calendar.containerEl.find('bases-plus-cal-today').text === '오늘', calendar.containerEl.find('bases-plus-cal-today').text);
		calendar.view.unload();

		const graph = await mountGraph([gEntry('Note A', '2026-08-01', 40)], { xProperty: null });
		check('그래프 안내 띠가 한글이다', gNotice(graph.containerEl) === '그래프를 그리려면 X 속성과 Y 속성을 정하세요.', String(gNotice(graph.containerEl)));
		graph.view.unload();

		// 빠진 행 수는 **자리 표시자**로 끼운다 — 한국어는 수 뒤에 단위가 붙어 영어와 어순이 다르다.
		const skipped = await mountGraph([
			gEntry('Note A', '2026-08-01', 40),
			gEntry('Note B', null, 55),
			gEntry('Note C', null, 60),
		]);
		check('빠진 행 안내가 한글 어순이다', gNotice(skipped.containerEl) === 'X 값이 없는 행 2개는 그리지 않았습니다.', String(gNotice(skipped.containerEl)));
		skipped.view.unload();

		// 페이저 — 숫자 자리가 한국어 어순으로 뒤바뀐다.
		const { app } = makeApp('visible');
		const paged = await mount(app, [makeEntry('A'), makeEntry('B'), makeEntry('C')], { stored: { rowLimit: 'pages', pageSize: '1' } });
		const pageEl = footerOf(paged.containerEl).find('bases-plus-pager-page');
		check('페이저 문구가 한글 어순이다', pageEl.attrs['aria-label'] === '3 페이지 중 1', String(pageEl.attrs['aria-label']));
		check('페이저 버튼이 한글이다', pagerButtons(footerOf(paged.containerEl))[0].attrs['aria-label'] === '이전 페이지', String(pagerButtons(footerOf(paged.containerEl))[0].attrs['aria-label']));
		paged.view.unload();
	}

	console.log('\n[101] 한글화 — 사전에 없는 언어는 영어 그대로');
	resetStubs();
	{
		const { app } = makeApp('visible');

		// 기본(영어)
		const en = await mount(app, [makeEntry('Note A')]);
		check('영어에서는 그대로다', en.registration.name === 'Plus table' && en.registration.options(en.config)[0].displayName === 'Open rows with');
		en.view.unload();

		// 사전이 없는 언어도 영어로 떨어진다 — 반쯤 번역된 화면을 만들지 않는다.
		stub.setLanguage('ja');
		const ja = await mount(app, [makeEntry('Note A')]);
		check('사전 없는 언어도 영어다', ja.registration.name === 'Plus table', ja.registration.name);
		ja.view.unload();

		stub.setLanguage('ko');
		const ko = await mount(app, [makeEntry('Note A')]);
		check('한국어면 한글이다', ko.registration.name === '플러스 표', ko.registration.name);
		ko.view.unload();

		// 설정 탭도 같은 사전을 쓴다.
		stub.setLanguage('ko');
		const plugin = ko.plugin;
		Setting.built.length = 0;
		plugin.settingTabs[0].display();
		check('설정 탭이 한글이다', Setting.built.length > 0);
	}
}
