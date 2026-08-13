import { TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import { addOpenItem } from '../shared/openTarget';
import type { OpenMode } from '../shared/openTarget';

/**
 * 내장 Bases 뷰(표·카드·목록) 우클릭 메뉴에 열기 항목 하나를 붙인다(D21 · N1 채택).
 *
 * 전량 공개 API 다 — `workspace.on('file-menu')` 는 계약된 이벤트이고, 내장 뷰가 이 이벤트를 쏘는
 * 지점은 [[스파이크- 네이티브 뷰 부착 판정]] 에서 실측했다. 비공개 접근은 없다.
 *
 * 다만 `link-context-menu` 는 볼트 안 모든 내부 링크에서 뜨므로 source 만으로는 못 거른다 —
 * 우클릭 대상이 `.bases-view` 안이었는지로 좁힌다. 이 DOM 검사만 계약 밖이며,
 * 클래스명이 바뀌면 항목이 안 뜰 뿐 오류는 나지 않는다.
 */

/** 내장 표에서 셀을 고르고 우클릭했을 때. 이 source 는 Bases 표에서만 나온다. */
const TABLE_SOURCE = 'bases-context-menu';
/** 파일 링크 우클릭. 표·카드·목록 공통이지만 Bases 밖에서도 나온다 — DOM 으로 좁힌다. */
const LINK_SOURCE = 'link-context-menu';

export interface NativeOpenMenuOptions {
	/** 설정 토글. 매번 읽어 설정 변경이 즉시 반영되게 한다. */
	isEnabled(): boolean;
	/** 내장 뷰에는 뷰 옵션이 없으므로 설정 탭의 전역 기본값을 쓴다. */
	getOpenMode(): OpenMode;
	/** 우리가 등록한 뷰 타입 — 그쪽엔 자체 진입점이 있으므로 항목을 넣지 않는다. */
	ownViewTypes: string[];
}

export function registerNativeOpenMenu(plugin: Plugin, options: NativeOpenMenuOptions): void {
	const tracker = new ContextTargetTracker(plugin);

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file, source) => {
			if (!options.isEnabled()) return;
			// 복수 선택(files-menu)은 붙이지 않는다 — 기본 방식이 모달이면 모달이 겹쳐 뜬다.
			if (!(file instanceof TFile)) return;
			if (!firedInNativeBasesView(source, tracker, options.ownViewTypes)) return;

			addOpenItem(menu, plugin.app, file, options.getOpenMode());
		})
	);
}

function firedInNativeBasesView(
	source: string,
	tracker: ContextTargetTracker,
	ownViewTypes: string[]
): boolean {
	if (source === TABLE_SOURCE) return true;
	if (source !== LINK_SOURCE) return false;

	const viewType = tracker.basesViewType();
	return viewType !== null && ownViewTypes.indexOf(viewType) === -1;
}

/**
 * 메뉴 콜백은 원본 이벤트를 받지 못한다. 그래서 캡처 단계에서 우클릭 대상을 먼저 기록해 둔다 —
 * document 캡처는 코어가 링크에 건 리스너보다 항상 먼저 돌고, 메뉴는 같은 tick 에 만들어진다.
 */
class ContextTargetTracker {
	private lastTarget: ClosestCapable | null = null;

	constructor(plugin: Plugin) {
		this.observe(plugin, document);

		// 새 창(팝아웃)은 document 가 따로다. 붙여 주지 않으면 그쪽에서만 항목이 안 뜬다.
		plugin.registerEvent(
			plugin.app.workspace.on('window-open', (_workspaceWindow, win) => {
				this.observe(plugin, win.document);
			})
		);
	}

	/** `.bases-view` 밖이면 null. 안이면 그 뷰의 타입 문자열(`table`·`cards`·`list`·커스텀 id). */
	basesViewType(): string | null {
		const target = this.lastTarget;
		if (!target || typeof target.closest !== 'function') return null;

		const viewEl = target.closest('.bases-view');
		return viewEl ? viewEl.getAttribute('data-view-type') : null;
	}

	private observe(plugin: Plugin, doc: Document): void {
		plugin.registerDomEvent(
			doc,
			'contextmenu',
			(evt) => {
				// 팝아웃 창은 realm 이 달라 `instanceof HTMLElement` 가 거짓이 된다 — 능력으로 판별한다.
				this.lastTarget = evt.target as ClosestCapable | null;
			},
			{ capture: true }
		);
	}
}

interface ClosestCapable {
	closest?(selector: string): Element | null;
}
