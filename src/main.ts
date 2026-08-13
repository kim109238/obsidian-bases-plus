import { Plugin } from 'obsidian';
import { BasesPlusSettingTab, DEFAULT_SETTINGS } from './settings';
import type { BasesPlusSettings } from './settings';
import { registerNativeOpenMenu } from './native/attachFileMenu';
import { resolveOpenMode } from './shared/openTarget';
import { PLUS_TABLE_VIEW_TYPE, registerPlusTableView } from './views/tableView';
import { PLUS_TIMELINE_VIEW_TYPE, registerPlusTimelineView } from './views/timelineView';
import { PLUS_CALENDAR_VIEW_TYPE, registerPlusCalendarView } from './views/calendarView';
import { PLUS_GRAPH_VIEW_TYPE, registerPlusGraphView } from './views/graphView';

export default class BasesPlusPlugin extends Plugin {
	settings: BasesPlusSettings = { ...DEFAULT_SETTINGS };
	/** 설정이 바뀌었을 때 알려 줄 곳들. 뷰가 스스로 등록하고 unload 때 스스로 뺀다(관4 — 뷰 참조를 들고 있지 않는다). */
	private readonly settingsListeners = new Set<() => void>();

	async onload(): Promise<void> {
		await this.loadSettings();

		// registerBasesView 는 내부에서 register() 로 해제까지 걸어둔다 — onunload 에서 따로 뗄 것이 없다.
		const host = {
			getDefaultPageSize: () => this.settings.defaultPageSize,
			onSettingsChanged: (callback: () => void) => {
				this.settingsListeners.add(callback);
				return () => this.settingsListeners.delete(callback);
			},
		};

		// 타임라인은 표를 상속한 뷰라 같은 host 를 쓴다 — 왼쪽 판이 표 그 자체이기 때문이다.
		// 달력·그래프는 페이징·그룹을 쓰지 않아 host 가 필요 없다 — 넘기지 않으면 설정 탭 값에 닿을 수도 없다.
		if (
			!registerPlusTableView(this, host) ||
			!registerPlusTimelineView(this, host) ||
			!registerPlusCalendarView(this) ||
			!registerPlusGraphView(this)
		) {
			console.error('Bases Plus: view registration failed because the Bases core plugin is disabled.');
		}

		// 내장 Bases 뷰 우클릭 부착(D21) — 설정 값을 매번 읽어 토글·방식 변경이 바로 먹는다.
		registerNativeOpenMenu(this, {
			isEnabled: () => this.settings.nativeMenuEnabled,
			getOpenMode: () => resolveOpenMode(this.settings.nativeOpenMode),
			ownViewTypes: [
				PLUS_TABLE_VIEW_TYPE,
				PLUS_TIMELINE_VIEW_TYPE,
				PLUS_CALENDAR_VIEW_TYPE,
				PLUS_GRAPH_VIEW_TYPE,
			],
		});

		this.addSettingTab(new BasesPlusSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		// `loadData()` 는 `any` 라 그대로 펼치면 타입이 풀린다 — 우리 설정 모양으로 좁혀 받는다.
		const stored = (await this.loadData()) as Partial<BasesPlusSettings> | null;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 열려 있는 뷰가 곧바로 새 기본값으로 다시 그린다. 코어에는 "설정이 바뀌었으니 뷰를 다시 그려라" 라고
		// 시킬 공개 경로가 없어(QueryController 는 d.ts 에 멤버가 없다) 우리 뷰에 직접 알린다.
		this.settingsListeners.forEach((listener) => listener());
	}
}
