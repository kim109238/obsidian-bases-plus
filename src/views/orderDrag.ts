/**
 * 드래그로 순서를 바꾸는 **하나뿐인 패턴**. 행·그룹 헤딩·값 순서 대화상자가 전부 이것을 쓴다
 * (디자인 F3 — "드래그로 순서를 바꾸는 패턴이 플러그인 안에 하나만 있어야 한다").
 *
 * HTML5 `draggable` 이 아니라 **포인터 이벤트 + `setPointerCapture`** 다. 열 폭 조절이 이미 같은 방식이고
 * (`tableView.ts` `onResizeStart`), 마우스·터치·펜이 한 경로이며 팝아웃 창에서도 동작한다.
 * 공식 가이드에 HTML5 draggable 의 모바일 터치 동작 언급이 없다는 것도 같은 판단이다(개발 원칙 4절).
 */

export interface OrderSlot {
	el: HTMLElement;
	/** 저장에 그대로 나가는 식별자 — 행은 파일 경로, 그룹은 그룹 키 문자열, 값 목록은 값 문자열이다. */
	id: string;
}

export interface OrderDragHost {
	/** 드롭 표시자의 좌표 기준. `position: relative` 여야 한다. */
	containerEl: HTMLElement;
	indicatorEl: HTMLElement;
	/**
	 * 끌고 있는 항목과 **같은 묶음**의 슬롯들 — 위에서 아래 순서. 그룹·페이지 경계를 여기서 잘라 넘긴다.
	 * 그래서 다른 그룹 위에서는 드롭 표시자가 아예 서지 않는다(C4).
	 */
	slots(id: string): OrderSlot[];
	/** 놓았을 때 **한 번**. 끄는 동안 저장하면 `.base`(임베드에서는 호스트 노트)를 그만큼 다시 쓴다. */
	commit(ids: string[]): void;
}

/** 포인터가 스크롤 영역 끝에서 이만큼 안쪽에 들어오면 자동 스크롤한다. */
const EDGE = 24;
const EDGE_STEP = 12;

interface Gesture {
	id: string;
	pointerId: number;
	handleEl: HTMLElement;
	slots: OrderSlot[];
	/** 지금 표시자가 서 있는 자리 — 슬롯 사이의 경계 번호(0..slots.length). */
	target: number;
	/** 드래그를 취소할 Escape 리스너. 놓거나 취소할 때 반드시 떼어 낸다. */
	detachKeys: () => void;
}

export class OrderDrag {
	private gesture: Gesture | null = null;

	constructor(private readonly host: OrderDragHost) {}

	get active(): boolean {
		return this.gesture !== null;
	}

	/** 손잡이를 눌렀다. 주 버튼이 아니거나 옮길 곳이 없으면 아무 일도 일어나지 않는다. */
	start(id: string, handleEl: HTMLElement, evt: PointerEvent): void {
		if (evt.button !== 0 || this.gesture) return;

		const slots = this.host.slots(id);
		const from = slots.findIndex((slot) => slot.id === id);
		if (from === -1 || slots.length < 2) return;

		evt.preventDefault();
		// 헤딩을 끄는 것이 접기로 새지 않게 한다 — 손잡이가 pointerdown 을 소비한다(D2).
		evt.stopPropagation();

		this.gesture = {
			id,
			pointerId: evt.pointerId,
			handleEl,
			slots,
			target: from,
			detachKeys: this.watchEscape(handleEl),
		};

		handleEl.addClass('is-active');
		slots[from].el.addClass('is-being-dragged');
		capturePointer(handleEl, evt.pointerId);
		this.moveIndicator(from);
	}

	move(evt: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		evt.preventDefault();
		this.autoScroll(evt.clientY);

		const target = boundaryAt(gesture.slots, evt.clientY);
		if (target === gesture.target) return;

		gesture.target = target;
		this.moveIndicator(target);
	}

	/** 놓았다. 자리가 실제로 바뀌었을 때만 저장한다 — 누르기만 하고 놓으면 `.base` 를 건드리지 않는다. */
	end(evt: PointerEvent): void {
		const gesture = this.gesture;
		if (!gesture || gesture.pointerId !== evt.pointerId) return;

		const ids = reorder(gesture.slots, gesture.id, gesture.target);
		this.finish();

		if (ids) this.host.commit(ids);
	}

	/** Escape·pointercancel·언로드 — 원위치로 두고 저장하지 않는다(C3). */
	cancel(): void {
		if (this.gesture) this.finish();
	}

	/** 손잡이에 포커스를 둔 채 화살표 키. 한 칸 옮기고 **즉시** 저장한다(C3). */
	nudge(id: string, delta: number): boolean {
		const slots = this.host.slots(id);
		const from = slots.findIndex((slot) => slot.id === id);
		const to = from + delta;
		if (from === -1 || to < 0 || to >= slots.length) return false;

		const ids = slots.map((slot) => slot.id);
		ids.splice(from, 1);
		ids.splice(to, 0, id);
		this.host.commit(ids);

		return true;
	}

	private finish(): void {
		const gesture = this.gesture;
		if (!gesture) return;

		this.gesture = null;
		gesture.detachKeys();
		gesture.handleEl.removeClass('is-active');
		releasePointer(gesture.handleEl, gesture.pointerId);
		gesture.slots.forEach((slot) => slot.el.removeClass('is-being-dragged'));
		this.host.indicatorEl.removeClass('is-active');
	}

	private moveIndicator(target: number): void {
		const { containerEl, indicatorEl } = this.host;
		const top = boundaryTop(containerEl, this.gesture?.slots ?? [], target);
		if (top === null) return;

		indicatorEl.addClass('is-active');
		indicatorEl.setCssStyles({ top: `${top}px` });
	}

	/**
	 * 포인터 캡처가 잡혀 있어 키 이벤트는 손잡이로 오지 않는다 — 문서에서 받는다.
	 * 등록과 해제가 이 클래스 안에서 짝을 이루므로 밖으로 새지 않는다.
	 */
	private watchEscape(handleEl: HTMLElement): () => void {
		const doc = handleEl.ownerDocument as
			| { addEventListener?: Function; removeEventListener?: Function }
			| undefined;
		if (!doc || typeof doc.addEventListener !== 'function') return () => {};

		const onKey = (evt: KeyboardEvent): void => {
			if (evt.key !== 'Escape') return;

			evt.preventDefault();
			this.cancel();
		};

		doc.addEventListener('keydown', onKey, true);

		return () => {
			if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKey, true);
		};
	}

	/** 스크롤 영역 위·아래 끝에서는 표를 따라 스크롤한다(C3). 스크롤 주체는 코어의 `.bases-view` 다. */
	private autoScroll(clientY: number): void {
		const scroller = scrollParent(this.host.containerEl);
		if (!scroller) return;

		const box = rectOf(scroller);
		if (!box) return;

		if (clientY < box.top + EDGE) scroller.scrollTop -= EDGE_STEP;
		else if (clientY > box.bottom - EDGE) scroller.scrollTop += EDGE_STEP;
	}
}

/**
 * 포인터가 지금 어느 경계에 있는지. 슬롯의 **가운데**를 넘으면 그 아래로 간다 —
 * 위에서 아래로 훑을 때 표시자가 한 칸씩 자연스럽게 내려간다.
 */
function boundaryAt(slots: OrderSlot[], clientY: number): number {
	for (let i = 0; i < slots.length; i++) {
		const box = rectOf(slots[i].el);
		if (!box) continue;

		if (clientY < box.top + box.height / 2) return i;
	}

	return slots.length;
}

/**
 * 경계 `target` 이 컨테이너 안에서 갖는 y. 슬롯이 없으면 null 이라 표시자를 건드리지 않는다.
 *
 * **스크롤 오프셋을 더해야 한다.** `getBoundingClientRect()` 는 지금 화면에 보이는 거리를 주는데,
 * 표시자는 `position: absolute` 라 그 `top` 이 **스크롤과 함께 움직이는 좌표계**에서 해석된다.
 * 그래서 스크롤된 목록에서는 잰 값이 `scrollTop` 만큼 작아 표시자가 그만큼 위에 그려진다
 * (헤드리스 실측: 스크롤 60 일 때 계산 60 · 실제 0 — 정확히 60px 어긋남).
 * 표의 행 컨테이너는 스스로 스크롤하지 않아 이 값이 0 이고, 값 순서 대화상자의 목록에서만 살아난다.
 */
function boundaryTop(containerEl: HTMLElement, slots: OrderSlot[], target: number): number | null {
	const origin = rectOf(containerEl);
	if (!origin || slots.length === 0) return null;

	const at = Math.min(target, slots.length - 1);
	const box = rectOf(slots[at].el);
	if (!box) return null;

	const scrolled = (containerEl as { scrollTop?: unknown }).scrollTop;
	const offset = typeof scrolled === 'number' ? scrolled : 0;

	return Math.round((target >= slots.length ? box.bottom : box.top) - origin.top) + offset;
}

/**
 * 새 순서. 자리가 그대로면 null 이라 호출부가 저장하지 않는다.
 * `target` 은 **원래 배열 기준의 경계**라, 자기 자리보다 뒤면 뽑아낸 만큼 한 칸 당겨진다.
 */
function reorder(slots: OrderSlot[], id: string, target: number): string[] | null {
	const ids = slots.map((slot) => slot.id);
	const from = ids.indexOf(id);
	if (from === -1) return null;

	const to = target > from ? target - 1 : target;
	if (to === from) return null;

	ids.splice(from, 1);
	ids.splice(to, 0, id);

	return ids;
}

interface Box {
	top: number;
	bottom: number;
	height: number;
}

/** 레이아웃이 없는 하네스에서는 0 이 나온다 — 그래도 계산이 터지지 않게 능력으로 확인한다. */
function rectOf(el: HTMLElement | undefined): Box | null {
	const measurable = el as { getBoundingClientRect?: () => Box } | undefined;
	if (typeof measurable?.getBoundingClientRect !== 'function') return null;

	const box = measurable.getBoundingClientRect();

	return typeof box?.top === 'number' ? box : null;
}

/** 세로로 스크롤되는 가장 가까운 조상. 우리 뷰에서는 코어 `.bases-view` 가 그것이다. */
function scrollParent(el: HTMLElement): HTMLElement | null {
	let current = el as (HTMLElement & { scrollHeight?: number; clientHeight?: number }) | null;

	while (current) {
		if (
			typeof current.scrollHeight === 'number' &&
			typeof current.clientHeight === 'number' &&
			current.scrollHeight > current.clientHeight
		) {
			return current;
		}

		current = current.parentElement as typeof current;
	}

	return null;
}

function capturePointer(el: HTMLElement, pointerId: number): void {
	const target = el as { setPointerCapture?(id: number): void };
	if (typeof target.setPointerCapture === 'function') target.setPointerCapture(pointerId);
}

function releasePointer(el: HTMLElement, pointerId: number): void {
	const target = el as { releasePointerCapture?(id: number): void };
	if (typeof target.releasePointerCapture === 'function') target.releasePointerCapture(pointerId);
}
