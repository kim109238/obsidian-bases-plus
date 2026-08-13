import { Notice, Platform } from 'obsidian';
import type { App, Menu, TFile } from 'obsidian';
import { openNoteModal } from './noteModal';
import { t } from './i18n';
import type { NoteModalAction } from './noteModal';

/**
 * 전 뷰 공용 열기 계층(묶음 A · F4·F6).
 *
 * 공개 함수는 `TFile` 만 받는다 — `BasesEntry` 나 뷰 인스턴스를 인자로 두면 Bases 밖에서(달력 뷰,
 * 네이티브 뷰 부착) 재사용할 수 없다. 근거는 [[스파이크- 네이티브 뷰 부착 판정]] 의 코드 공유 구조 절.
 *
 * D21 확정 모델 — 진입점은 "기본 방식으로 연다" 하나뿐이고, 탭·새 창 승격은 모달 안에서 한다.
 */
export type OpenMode = 'modal' | 'tab' | 'window';

export const DEFAULT_OPEN_MODE: OpenMode = 'modal';

/** 네이티브·우리 뷰의 우클릭 항목에 함께 쓰는 문구. 어느 뷰에서 눌러도 같은 이름이어야 한다. */
export const OPEN_ITEM_TITLE = 'Open with Bases Plus';

interface OpenModeSpec {
	/** 동작을 그대로 말하는 이름 — 툴팁·모달 버튼용. */
	label: string;
	/** 선택지 이름 — 뷰 옵션·설정 드롭다운용. 모달 버튼의 짧은 문구로도 쓴다. */
	choice: string;
	/**
	 * 코어가 같은 동작의 메뉴 항목에 쓰는 아이콘과 같다 — 실측(1.13.4 app.js): "Open in new tab" 은
	 * `lucide-file-plus`(오프셋 1475705·2684052·2885067), "Open in new window" 는
	 * `lucide-picture-in-picture-2`(오프셋 2834316·3159570). 코어 메뉴는 옆에 문구가 있어 뜻이 읽히므로,
	 * 문구 없이 아이콘만 두면 다르게 읽힌다 — 그래서 모달 버튼에는 아이콘과 문구를 함께 둔다.
	 */
	icon: string;
}

const OPEN_MODES: Record<OpenMode, OpenModeSpec> = {
	modal: { label: 'Open in modal', choice: 'Modal', icon: 'maximize' },
	tab: { label: 'Open in new tab', choice: 'New tab', icon: 'file-plus' },
	window: { label: 'Open in new window', choice: 'New window', icon: 'picture-in-picture-2' },
};

const ALL_OPEN_MODES: OpenMode[] = ['modal', 'tab', 'window'];

/** `openPopoutLeaf` 는 데스크톱 앱 전용이다(d.ts 명시). 모바일에선 새 창 선택지를 감춘다. */
export function isOpenModeAvailable(mode: OpenMode): boolean {
	return mode !== 'window' || Platform.isDesktopApp;
}

export function openModeLabel(mode: OpenMode): string {
	return t(OPEN_MODES[mode].label);
}

export function openModeIcon(mode: OpenMode): string {
	return OPEN_MODES[mode].icon;
}

/** 뷰 옵션·설정에 저장된 값은 무엇이든 들어올 수 있다 — 모르는 값이면 기본값으로 되돌린다. */
export function resolveOpenMode(value: unknown, fallback: OpenMode = DEFAULT_OPEN_MODE): OpenMode {
	const mode = ALL_OPEN_MODES.find((candidate) => candidate === value);
	if (!mode || !isOpenModeAvailable(mode)) return fallback;

	return mode;
}

/** 드롭다운(뷰 옵션·설정 탭)에 넣을 선택지. 쓸 수 없는 모드는 애초에 고를 수 없게 뺀다. */
export function openModeChoices(): Record<string, string> {
	const choices: Record<string, string> = {};

	for (const mode of ALL_OPEN_MODES) {
		if (isOpenModeAvailable(mode)) choices[mode] = t(OPEN_MODES[mode].choice);
	}

	return choices;
}

/**
 * 노트를 모달·새 탭·새 창 중 하나로 연다.
 *
 * 모달만 비공개 API(분리된 leaf 생성)에 의존한다 — 실패하면 새 탭으로 떨어뜨려 기능 상실이 아니라
 * 등급 하락이 되게 한다(D4 확정안의 폴백).
 */
export async function openTarget(app: App, file: TFile, mode: OpenMode): Promise<void> {
	if (mode === 'modal') {
		const opened = await openNoteModal(app, file, promotionActions(), (next) => {
			void openTarget(app, file, next);
		});
		if (opened) return;

		new Notice(t('Bases Plus could not open a modal. Opening a new tab instead.'));
		await openInTab(app, file);
		return;
	}

	if (mode === 'window' && Platform.isDesktopApp) {
		try {
			// 열어 준 탭·창은 추적하지도 onunload 에서 떼지도 않는다(관3 — 떼면 사용자가 옮겨둔 위치가 날아간다).
			await app.workspace.openPopoutLeaf().openFile(file);
			return;
		} catch (error) {
			console.error('Bases Plus: opening a popout window failed.', error);
		}
	}

	await openInTab(app, file);
}

/**
 * 메뉴에 열기 항목 **하나**를 붙인다 — 설정된 기본 방식으로 연다(D21 확정, 마스터 지정).
 * 코어 링크 메뉴와 같은 `open` 섹션에 들어가 위치가 일관된다.
 */
export function addOpenItem(menu: Menu, app: App, file: TFile, mode: OpenMode): void {
	const effective = resolveOpenMode(mode);

	menu.addItem((item) =>
		item
			.setSection('open')
			.setTitle(t(OPEN_ITEM_TITLE))
			.setIcon(OPEN_MODES[effective].icon)
			.onClick(() => {
				void openTarget(app, file, effective);
			})
	);
}

/** 모달 안에서 제안할 승격 수단 — F6 은 이 경로로 충족된다(D21). 모달 자신과 쓸 수 없는 모드는 뺀다. */
function promotionActions(): NoteModalAction[] {
	const actions: NoteModalAction[] = [];

	for (const mode of ALL_OPEN_MODES) {
		if (mode === 'modal' || !isOpenModeAvailable(mode)) continue;
		actions.push({
			mode,
			label: t(OPEN_MODES[mode].label),
			shortLabel: t(OPEN_MODES[mode].choice),
			icon: OPEN_MODES[mode].icon,
		});
	}

	return actions;
}

async function openInTab(app: App, file: TFile): Promise<void> {
	await app.workspace.getLeaf('tab').openFile(file);
}
