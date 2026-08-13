import { App, PluginSettingTab, Setting } from 'obsidian';
import type BasesPlusPlugin from './main';
import { DEFAULT_OPEN_MODE, openModeChoices, resolveOpenMode } from './shared/openTarget';
import { MIN_PAGE_SIZE, resolvePageSize } from './views/rowPlan';
import type { OpenMode } from './shared/openTarget';
import { t } from './shared/i18n';

export interface BasesPlusSettings {
	/** 뷰에 자체 pageSize 옵션이 없을 때 쓰는 기본 페이지 크기 (묶음 B/F3). */
	defaultPageSize: number;
	/** 내장 Bases 뷰 우클릭 메뉴에 열기 항목을 넣을지 (D21). */
	nativeMenuEnabled: boolean;
	/**
	 * 내장 Bases 뷰에서 열 때의 방식. 내장 뷰에는 우리 뷰 옵션이 없어 이 전역값을 따른다.
	 * 우리 뷰(Plus table)는 자기 뷰 옵션이 우선한다 — 여기 값을 보지 않는다.
	 */
	nativeOpenMode: OpenMode;
}

export const DEFAULT_SETTINGS: BasesPlusSettings = {
	defaultPageSize: 50,
	nativeMenuEnabled: true,
	nativeOpenMode: DEFAULT_OPEN_MODE,
};

export class BasesPlusSettingTab extends PluginSettingTab {
	plugin: BasesPlusPlugin;

	constructor(app: App, plugin: BasesPlusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("Add an open item to Obsidian's own Bases views"))
			.setDesc(
				t('Shows a "Bases Plus" item when you right-click a row in the built-in table, cards, and list views.')
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.nativeMenuEnabled).onChange(async (value) => {
					this.plugin.settings.nativeMenuEnabled = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("Open mode for Obsidian's own Bases views"))
			.setDesc(
				t('How that item opens a note. Views added by this plugin ignore this and use their own view option in the Bases toolbar.')
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(openModeChoices())
					.setValue(this.plugin.settings.nativeOpenMode)
					.onChange(async (value) => {
						this.plugin.settings.nativeOpenMode = resolveOpenMode(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('Default rows per page'))
			.setDesc(t('Used by views that have no number of their own. Views with a number keep it.'))
			// 설정 API 에도 숫자 컨트롤이 없다 — 텍스트 입력의 input 타입을 number 로 바꿔 쓴다(`inputEl` 은 d.ts 공개).
			// 뷰 옵션(`Rows per page`)과 같은 방식이라 1 단위 조절·직접 입력이 양쪽에서 똑같이 된다.
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(MIN_PAGE_SIZE);
				text.inputEl.step = '1';
				text
					.setValue(String(this.plugin.settings.defaultPageSize))
					.onChange(async (value) => {
						this.plugin.settings.defaultPageSize = resolvePageSize(value, DEFAULT_SETTINGS.defaultPageSize);
						await this.plugin.saveSettings();
					});
			});

		// 뷰 옵션에는 설명을 붙일 자리가 없다(공개 `BasesOption` 에 description 필드가 없다) — 한계는 여기 적는다.
		new Setting(containerEl)
			.setName(t('Calendar tasks'))
			// 한 줄로 둔다 — 이어 붙이면 사전의 원문과 글자가 달라져 번역이 조용히 안 걸린다.
			.setDesc(
				t(
					'The calendar reads due dates written with the Tasks emoji syntax, like 📅 2026-08-06. Dates written as Dataview inline fields (due::) only show up when the Tasks plugin is installed.'
				)
			);
	}
}
