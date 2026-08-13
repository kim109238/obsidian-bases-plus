'use strict';

// 옵시디언이 주입하는 모듈·DOM 확장의 최소 스텁. 번들을 실제로 require 해 돌리기 위한 검증 자산으로 plugin/test/ 에 둔다.

let idSeq = 0;

class FakeEl {
	constructor(tag, cls) {
		this.tag = tag;
		this.id = ++idSeq;
		this.classes = new Set();
		this.children = [];
		this.parent = null;
		this.text = '';
		this.attrs = {};
		this.listeners = [];
		this.hidden = false;
		this.style = {};
		this.iconName = null;
		this.tooltip = null;
		/** 레이아웃이 없으므로 폭은 테스트가 직접 넣어 준다(열 폭 굳히기·자동 맞춤 검증용). */
		this.offsetWidth = 0;
		this.scrollWidth = 0;
		/** 안쪽 스크롤 컨테이너의 넘침을 계산할 때 쓴다(알약 칸 자동 폭). */
		this.clientWidth = 0;
		/** 세로 좌표 — 드래그가 드롭 자리를 정할 때 쓴다. 실물도 레이아웃 전에는 전부 0 이다. */
		this.offsetTop = 0;
		this.offsetHeight = 0;
		/**
		 * 스크롤 위치. 실물에서는 늘 있는 값이고, 스크롤된 목록 위에 절대 배치 요소를 세울 때
		 * 좌표가 이만큼 어긋난다(헤드리스 실측). 없는 것으로 두면 그 계산이 스텁에서만 다른 가지를 탄다.
		 */
		this.scrollTop = 0;
		this.captured = null;
		// 실물 입력 요소는 만들어진 순간부터 value 가 빈 문자열이다 — undefined 로 두면 아직 아무것도 안 친
		// 입력칸을 읽는 코드가 스텁에서만 터진다(목록 편집기의 빈 입력칸 Backspace).
		if (tag === 'input' || tag === 'textarea') this.value = '';
		if (cls) String(cls).split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
	}

	_child(tag, arg) {
		let cls = '';
		let text = '';
		let attr = null;
		if (typeof arg === 'string') cls = arg;
		else if (arg && typeof arg === 'object') {
			cls = Array.isArray(arg.cls) ? arg.cls.join(' ') : arg.cls || '';
			text = arg.text || '';
			attr = arg.attr || null;
		}
		const el = new FakeEl(tag, cls);
		if (text) el.text = text;
		if (attr) Object.assign(el.attrs, attr);
		el.parent = this;
		this.children.push(el);
		return el;
	}

	createDiv(arg) { return this._child('div', arg); }
	createSpan(arg) { return this._child('span', arg); }
	createEl(tag, arg) { return this._child(tag, arg); }

	/**
	 * SVG 요소. **실물은 HTML 요소와 표면이 다르다** — 옵시디언 DOM 확장(1.13.6 `enhance.js`)은
	 * `show`·`hide`·`on`·`isShown` 을 `HTMLElement.prototype` 에만 걸고 `SVGElement.prototype` 에는
	 * `setCssStyles`·`setCssProps` 둘만 건다(헤드리스 실측 — 대조군 div 에는 전부 있다).
	 * 스텁이 이 차이를 안 흉내 내면 SVG 에 `hide()` 를 부르는 코드가 하네스만 통과하고 실물에서 터진다.
	 */
	createSvg(tag, arg) {
		const el = this._child(tag, arg);
		el.svg = true;

		return el;
	}

	appendChild(el) {
		/*
		 * **이미 붙어 있는 노드를 다시 붙이는 것은 뽑았다 꽂는 것이다.** 실물 DOM 은 그때 그 서브트리가
		 * 쥐고 있던 포인터 캡처를 암묵적으로 놓아 준다(lostpointercapture) — 그 뒤의 pointermove·pointerup 은
		 * 그 요소로 안 온다. 갱신마다 요소를 다시 append 하는 우리 구조에서는 드래그가 그 순간 끊긴다.
		 * 스텁이 이걸 흉내 내지 않으면 "떼도 안 끝나는 드래그"가 하네스를 그냥 통과한다(마스터 4차 4·5번).
		 */
		if (el.parent) {
			el.parent.children = el.parent.children.filter((c) => c !== el);
			el.releaseCaptureTree();
		}
		el.parent = this;
		this.children.push(el);
		return el;
	}

	/** 자기와 하위가 쥔 포인터 캡처를 놓는다 — 실물의 암묵 해제와 같은 자리. */
	releaseCaptureTree() {
		if (this.captured !== null) {
			const id = this.captured;
			this.captured = null;
			this.dispatch('lostpointercapture', { pointerId: id });
		}
		this.children.forEach((child) => child.releaseCaptureTree());
	}

	empty() { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.text = ''; }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
	detach() { this.remove(); }

	addClass(...cls) { cls.forEach((c) => this.classes.add(c)); }
	removeClass(...cls) { cls.forEach((c) => this.classes.delete(c)); }
	hasClass(c) { return this.classes.has(c); }
	toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); }

	setText(t) { this.text = String(t); this.children = []; }
	/** 실제 DOM 과 같이 하위 텍스트를 모두 이어 준다 — 편집 시작값이 이 값으로 잡힌다. */
	get textContent() { return this.text || this.children.map((c) => c.textContent).join(''); }
	/** 입력 요소용 최소 표면. */
	focus() { this.focused = true; this.dispatch('focus'); }
	/** 실물처럼 blur 이벤트까지 낸다 — 코드가 blur() 로 편집을 끝내는 경로가 있다. */
	blur() { this.focused = false; this.dispatch('blur'); }
	select() { this.selected = true; }
	/** 날짜 입력의 달력 — 실제로 못 띄우니 호출만 기록한다. */
	showPicker() { this.pickerShown = true; }
	setAttr(k, v) { this.attrs[k] = v; }
	getAttr(k) { return this.attrs[k]; }
	/**
	 * 실물 요소가 늘 갖는 DOM 표준 표면. 옵시디언 헬퍼(`setAttr`)만 두면 표준 쪽을 쓰는 코드가
	 * **스텁에서만 터진다** — 속성 줄의 툴팁을 떼는 호출이 그랬다(렌더가 통째로 실패했다).
	 */
	setAttribute(k, v) { this.attrs[k] = v; }
	getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
	removeAttribute(k) { delete this.attrs[k]; }

	/**
	 * 실물은 레이아웃이 없어도 이 메서드를 늘 갖고 0 을 돌려준다 — 없는 것으로 두면 드래그 계산이
	 * 스텁에서만 다른 가지를 탄다. 테스트는 offsetTop·offsetHeight 를 심어 실제 좌표를 흉내 낸다.
	 */
	getBoundingClientRect() {
		return {
			top: this.offsetTop,
			bottom: this.offsetTop + this.offsetHeight,
			height: this.offsetHeight,
			left: 0,
			right: this.offsetWidth,
			width: this.offsetWidth,
		};
	}
	/**
	 * 실물은 `CSSStyleDeclaration` 에 그대로 대입한다 — 그래서 **커스텀 속성(`--x`)은 조용히 무시된다.**
	 * 스텁이 받아 주면 화면에서만 죽는 버그를 하네스가 통과시킨다(옵시디언이 `setCssProps` 를 따로 둔 이유).
	 */
	setCssStyles(s) {
		Object.keys(s).forEach((name) => {
			if (name.startsWith('--')) return;
			this.style[name] = s[name];
		});
	}

	/** 커스텀 속성 전용 통로(d.ts 공개). 실물은 `style.setProperty` 를 부른다. */
	setCssProps(props) { Object.assign(this.style, props); }

	hide() { this._htmlOnly('hide'); this.hidden = true; }
	show() { this._htmlOnly('show'); this.hidden = false; }

	/** SVG 에는 없는 헬퍼를 부르면 실물처럼 터진다(위 `createSvg` 주석의 실측). */
	_htmlOnly(name) {
		if (this.svg) throw new TypeError(`stub: <${this.tag}> 는 SVG 라 ${name}() 이 없다 (HTMLElement.prototype 전용)`);
	}

	/** 폭 조절이 잡는 포인터. 실제 캡처는 없고 호출만 기록한다. */
	setPointerCapture(id) { this.captured = id; }
	releasePointerCapture(id) { if (this.captured === id) this.captured = null; }

	addEventListener(type, cb) { this.listeners.push({ type, cb }); }
	removeEventListener(type, cb) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.cb === cb)); }

	/** 기본값은 "수식어 없는 주 버튼 클릭" 이다 — 링크 위 클릭 분기를 보려면 button·metaKey 를 넘긴다. */
	dispatch(type, evt) {
		const event = Object.assign(
			{
				type,
				button: 0,
				defaultPrevented: false,
				propagationStopped: false,
				preventDefault() { this.defaultPrevented = true; },
				stopPropagation() { this.propagationStopped = true; },
			},
			evt || {}
		);
		this.listeners.filter((l) => l.type === type).forEach((l) => l.cb(event));
		return event;
	}

	/**
	 * 실물 요소가 늘 갖는 표면 둘. 없는 것으로 두면 이걸 쓰는 코드가 스텁에서만 다른 가지를 탄다 —
	 * 달력의 끝단 드래그가 칸 폭을 재는 경로가 그랬다(하네스는 통과하고 실물만 동작).
	 */
	get parentElement() { return this.parent; }
	/**
	 * 실물 요소는 늘 문서를 안다. 없는 것으로 두면 문서에 리스너를 거는 코드가 **조용히 아무것도 안 한다** —
	 * 끄는 중 Esc 취소가 그 경로라 하네스에서 검증조차 안 됐다(4차). `defaultView` 는 노드에 없어
	 * undefined 이고, 그걸 쓰는 코드는 전부 능력 확인 뒤 폴백을 갖는다.
	 */
	get ownerDocument() { return global.document || null; }
	/** 클래스 셀렉터(`.foo`)만 다룬다 — 우리 코드가 쓰는 형태가 그것뿐이다. */
	querySelector(selector) {
		const cls = String(selector).replace(/^\./, '');
		return this.children.reduce((hit, child) => hit || (child.classes.has(cls) ? child : child.querySelector(selector)), null);
	}

	/** 하위 트리에서 클래스로 찾기 — 검증용. */
	find(cls) {
		if (this.classes.has(cls)) return this;
		for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
		return null;
	}

	findAll(cls, acc) {
		acc = acc || [];
		if (this.classes.has(cls)) acc.push(this);
		this.children.forEach((c) => c.findAll(cls, acc));
		return acc;
	}

	countNodes() { return this.children.reduce((n, c) => n + 1 + c.countNodes(), 0); }
}

class Component {
	constructor() { this._registered = []; this._domEvents = []; this._children = []; }
	register(cb) { this._registered.push(cb); }
	registerEvent(ref) { this._registered.push(() => ref); }
	registerDomEvent(el, type, cb) { this._domEvents.push({ el, type, cb }); el.addEventListener(type, cb); }
	addChild(c) { this._children.push(c); return c; }
	unload() {
		this._domEvents.forEach(({ el, type, cb }) => el.removeEventListener(type, cb));
		this._registered.forEach((cb) => cb());
		if (typeof this.onunload === 'function') this.onunload();
	}
}

/**
 * 실물 형상에 맞춘다 — 1.13.4 app.js 오프셋 2488870 의 기반 클래스 생성자는 `app`·`queryController`·
 * `allProperties` 만 세운다. **`config` 와 `data` 는 여기서 안 세운다.**
 * 컨트롤러가 팩토리를 부른 다음 줄에서 `view.config = ...` 를 붙이고(오프셋 2500709),
 * `data` 는 갱신 때마다 `view.data = new BasesQueryResult(...)` 로 갈아 끼운 뒤 `onDataUpdated()` 를 부른다
 * (오프셋 2502560). 스텁이 생성자에서 config 를 세워 두면 생성자 안 config 접근 버그를 못 잡는다.
 */
class BasesView extends Component {
	constructor(controller) {
		super();
		this.queryController = controller;
		this.app = controller.app;
		this.allProperties = [];
	}

	/**
	 * 공개 API(d.ts `@since 1.10.2`). 실물은 새 노트 메뉴를 띄우고 콜백으로 프론트매터를 손보게 하는데,
	 * 여기서는 **그 콜백이 무엇을 심었는지**만 남긴다 — 항목 추가가 그룹 값을 제대로 넣는지가 검증 대상이다.
	 */
	async createFileForView(baseFileName, frontmatterProcessor) {
		const frontmatter = {};
		if (frontmatterProcessor) frontmatterProcessor(frontmatter);
		BasesView.created.push({ baseFileName, frontmatter });
	}
}
BasesView.created = [];

/**
 * 코어와 같은 DOM 을 만든다 — X → 헤더(제목) → 본문 순(app.js 오프셋 1131131).
 *
 * 래퍼 `.modal-header` 를 빼면 두 가지가 실물과 달라져 검수를 통과시켜 놓고 실물은 안 고쳐진다:
 * ①`.modal-header` 의 `margin-bottom: 0.75em`(11.25px) 팬텀 여백이 재현되지 않는다
 * ②`.modal-title` 이 `.modal` 직속 flex 항목이 되어 `margin-inline: auto` 가 가로 중앙 정렬로 먹는다.
 * 닫기 버튼 클래스도 실물과 같아야 한다 — 플러그인 Modal 이 만드는 것은 `.modal-header-button` 이다.
 */
/**
 * 쿼리 결과 — **형상이 실물과 같아야 한다.** 1.13.4 는 `data` 만 인스턴스 소유이고 `properties` 와
 * `groupedData` 는 **프로토타입의 non-enumerable getter** 다
 * (`Object.defineProperty(e.prototype,"groupedData",{get:...,enumerable:!1})`).
 *
 * 이 차이가 실물에서만 나는 버그를 만든다 — 결과 객체를 `{...result}` 로 얕게 베끼면 프로토타입이 끊겨
 * 두 getter 가 통째로 사라진다. 스텁을 평범한 객체로 두면 그 사고가 하네스를 그냥 통과한다.
 */
class BasesQueryResult {
	constructor(data, properties, groupedData) {
		this.data = data || [];
		this._properties = properties || [];
		this._groupedData = groupedData || null;
	}
}
Object.defineProperty(BasesQueryResult.prototype, 'properties', {
	get() { return this._properties; },
	enumerable: false,
	configurable: true,
});
Object.defineProperty(BasesQueryResult.prototype, 'groupedData', {
	get() {
		// 실물도 그룹 기준이 없으면 키 없는 묶음 하나를 준다(d.ts 주석과 같은 계약).
		return this._groupedData || [{ key: null, hasKey: () => false, entries: this.data }];
	},
	enumerable: false,
	configurable: true,
});

class Modal {
	constructor(app) {
		this.app = app;
		this.containerEl = new FakeEl('div', 'modal-container');
		this.modalEl = this.containerEl.createDiv('modal');
		this.closeButtonEl = this.modalEl.createDiv('modal-header-button mod-raised clickable-icon');
		this.headerEl = this.modalEl.createDiv('modal-header');
		this.titleEl = this.headerEl.createDiv('modal-title');
		this.contentEl = this.modalEl.createDiv('modal-content');
		this.isOpen = false;
		Modal.instances.push(this);
	}
	setTitle(t) { this.titleEl.setText(t); return this; }
	open() { this.isOpen = true; if (this.onOpen) this.onOpen(); }
	close() { this.isOpen = false; if (this.onClose) this.onClose(); }
}
Modal.instances = [];

class MenuItem {
	constructor() { this.section = null; this.title = null; this.icon = null; this.click = null; this.disabled = false; }
	setSection(s) { this.section = s; return this; }
	setTitle(t) { this.title = t; return this; }
	setIcon(i) { this.icon = i; return this; }
	setDisabled(d) { this.disabled = d; return this; }
	setChecked(c) { this.checked = c; return this; }
	onClick(cb) { this.click = cb; return this; }
}

class Menu {
	constructor() { this.items = []; this.shown = false; Menu.instances.push(this); }
	addItem(cb) { const item = new MenuItem(); cb(item); this.items.push(item); return this; }
	addSeparator() { return this; }
	showAtMouseEvent() { this.shown = true; return this; }
	showAtPosition() { this.shown = true; return this; }
}
Menu.instances = [];

class WorkspaceLeaf {
	constructor(app) {
		if (WorkspaceLeaf.constructorThrows) throw new Error('stub: WorkspaceLeaf constructor is not callable');
		this.app = app;
		this.view = { containerEl: new FakeEl('div', 'workspace-leaf-content') };
		this.opened = [];
		this.detached = false;
		WorkspaceLeaf.instances.push(this);
	}
	async openFile(file, state) {
		if (WorkspaceLeaf.openFileThrows) throw new Error('stub: openFile failed');
		this.opened.push({ file, state });
	}
	detach() { this.detached = true; }
}
WorkspaceLeaf.instances = [];
WorkspaceLeaf.constructorThrows = false;
WorkspaceLeaf.openFileThrows = false;

class Notice {
	constructor(message) { this.message = message; Notice.messages.push(message); }
}
Notice.messages = [];

class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeEl('div', 'settings'); } }

class Setting {
	constructor(containerEl) { this.containerEl = containerEl; }
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addSlider(cb) { const c = { setLimits: () => c, setValue: () => c, setDynamicTooltip: () => c, onChange: () => c }; cb(c); Setting.built.push({ kind: 'slider' }); return this; }
	/** 실물 TextComponent 처럼 `inputEl` 을 노출한다(d.ts 공개) — 숫자 입력으로 바꿔 쓰는 경로를 그대로 태운다. */
	addText(cb) {
		const rec = { kind: 'text', value: null, change: null, inputEl: new FakeEl('input') };
		const c = {
			inputEl: rec.inputEl,
			setValue: (v) => { rec.value = v; return c; },
			setPlaceholder: (p) => { rec.placeholder = p; return c; },
			onChange: (fn) => { rec.change = fn; return c; },
		};
		cb(c);
		Setting.built.push(rec);
		return this;
	}
	addToggle(cb) { const c = { setValue: () => c, onChange: () => c }; cb(c); Setting.built.push({ kind: 'toggle' }); return this; }
	addDropdown(cb) { const rec = { kind: 'dropdown', options: null, value: null }; const c = { addOptions: (o) => { rec.options = o; return c; }, setValue: (v) => { rec.value = v; return c; }, onChange: () => c }; cb(c); Setting.built.push(rec); return this; }
}
Setting.built = [];

class Plugin extends Component {
	constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.basesViews = []; this.settingTabs = []; }
	registerBasesView(id, registration) { this.basesViews.push({ id, registration }); return true; }
	addSettingTab(tab) { this.settingTabs.push(tab); }
	async loadData() { return null; }
	async saveData() {}
}

const Platform = { isDesktopApp: true, isMobile: false, isDesktop: true, isMobileApp: false };

/**
 * 값 객체 — 연관 행이 `BasesEntry` 없이 셀을 채울 때 **우리가 직접 만드는** 그 클래스들이다
 * (판정 ②). 실물처럼 static `type` 을 갖고 `renderTo` 로 마크업을 남긴다.
 */
class Value {
	renderTo(el) { el.setText(String(this)); }
	toString() { return ''; }
}
class StringValue extends Value {
	constructor(data) { super(); this.data = data; }
	toString() { return String(this.data); }
}
StringValue.type = 'String';
class NumberValue extends StringValue {}
NumberValue.type = 'Number';
class BooleanValue extends StringValue {
	renderTo(el) { el.createEl('input', { attr: { type: 'checkbox', checked: !!this.data, disabled: true } }); }
}
BooleanValue.type = 'Boolean';
class TagValue extends StringValue {
	renderTo(el) { el.createSpan({ cls: 'tag', text: String(this.data) }); }
}
TagValue.type = 'Tag';
class ListValue extends Value {
	constructor(items) { super(); this.items = items.slice(); }
	length() { return this.items.length; }
	get(i) { return this.items[i]; }
	toString() { return this.items.map(String).join(', '); }
	renderTo(el) { el.createDiv({ cls: 'value-list-container', text: this.toString() }); }
}
ListValue.type = 'List';
class DateValue extends StringValue {
	renderTo(el) { el.createEl('input', { attr: { type: 'date', value: String(this.data), disabled: true } }); }
	/** 실물 정규식과 같은 범위 — 날짜와 날짜+시각을 받고 형식이 안 맞으면 null 이다. */
	static parseFromString(input) {
		return /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(String(input).trim()) ? new DateValue(String(input).trim()) : null;
	}
}
DateValue.type = 'Date';
class LinkValue extends StringValue {
	constructor(raw, display) { super(raw); this.display = display; }
	renderTo(el) { el.createSpan({ cls: 'internal-link', text: this.display || String(this.data) }); }
	/** 실물은 `[[..]]` 안쪽을 링크텍스트로 읽는다 — 아니면 null 이라 호출부가 문자열로 떨어진다. */
	static parseFromString(app, input, sourcePath) {
		const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(String(input).trim());
		return match ? new LinkValue(match[1], match[2] || match[1]) : null;
	}
}
LinkValue.type = 'Link';
class NullValue extends Value {
	toString() { return 'null'; }
	renderTo() {}
}
NullValue.type = 'Null';
NullValue.value = new NullValue();

/** 실물과 같은 규칙 — `#` 앵커·`|` 별칭을 떼고 파일 경로 부분만 남긴다. */
function getLinkpath(linktext) {
	return String(linktext).split('|')[0].split('#')[0].trim();
}

/**
 * 화면 언어. 실물은 공개 `getLanguage()` 로 앱 설정 언어를 준다(d.ts `@since 1.8.7`).
 * 테스트가 `setLanguage()` 로 바꾼 값을 그대로 돌려주고, `resetStubs()` 가 영어로 되돌린다.
 */
let appLanguage = 'en';
function getLanguage() { return appLanguage; }
function setLanguage(code) { appLanguage = code || 'en'; }

function setIcon(el, icon) { el.iconName = icon; }
/**
 * 툴팁. **SVG 요소에는 걸 수 없다** — 실물은 `aria-label` 을 심어 두고 hover 때 코어 툴팁 렌더러가
 * 대상의 `isShown()` 을 부르는데, 그 헬퍼가 `HTMLElement.prototype` 에만 있어 SVG 에서는 값이 뜨는 대신
 * 매번 TypeError 가 난다(1.13.6 app.js 오프셋 1058520 · enhance.js 헤드리스 실측).
 * 실물은 hover 에서 터지고 여기서는 호출에서 터진다 — 같은 결함을 하네스가 먼저 잡게 하는 쪽이다.
 */
function setTooltip(el, tooltip, options) {
	if (el && el.svg) throw new TypeError('stub: SVG 요소에는 툴팁이 뜨지 않는다 (코어 툴팁이 isShown() 을 부른다)');

	el.tooltip = tooltip;
	// 실물이 하는 일이 이것뿐이다 — 화면 검증에서도 코어가 위임으로 잡는 그 표식이 DOM 에 남아야 한다.
	el.attrs['aria-label'] = tooltip;

	// 옵션도 실물처럼 `data-*` 로 심는다(app.js 오프셋 1060639 `Yg`) — 코어 툴팁이 뜰 때 그 자리를 다시 읽는다.
	const opts = options || {};
	if (opts.placement && opts.placement !== 'bottom') el.attrs['data-tooltip-position'] = opts.placement;
	if (opts.classes) el.attrs['data-tooltip-classes'] = opts.classes.join(' ');
	if (opts.delay) el.attrs['data-tooltip-delay'] = String(opts.delay);
	if (opts.gap) el.attrs['data-tooltip-gap'] = String(opts.gap);
}

/** 실물과 같은 규칙 — 첫 점 앞이 출처(note·file·formula), 뒤가 속성 이름이다(obsidian.d.ts `BasesPropertyId`). */
function parsePropertyId(propertyId) {
	const at = String(propertyId).indexOf('.');
	return { type: propertyId.slice(0, at), name: propertyId.slice(at + 1) };
}

module.exports = {
	FakeEl,
	Component,
	BasesView,
	Modal,
	Menu,
	MenuItem,
	WorkspaceLeaf,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Platform,
	BasesQueryResult,
	setIcon,
	setTooltip,
	getLanguage,
	setLanguage,
	parsePropertyId,
	getLinkpath,
	Value,
	StringValue,
	NumberValue,
	BooleanValue,
	TagValue,
	ListValue,
	DateValue,
	LinkValue,
	NullValue,
	/**
	 * 실물 `TFile` 은 `stat`(ctime·mtime·size)을 늘 갖는다(d.ts `TAbstractFile` → `TFile.stat`).
	 * 없는 것으로 두면 수정 시각으로 캐시를 무효화하는 코드가 스텁에서만 다른 가지를 탄다 —
	 * 달력 태스크 수집이 그 경로다(파일이 안 바뀌면 본문을 다시 읽지 않는다).
	 */
	TFile: class TFile {
		constructor() {
			this.stat = { ctime: 0, mtime: 0, size: 0 };
		}
	},
};
