import { Modal, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { OpenMode } from './openTarget';
import { t } from './i18n';

/**
 * 모달 안에서 네이티브 편집기를 그대로 띄운다(D4 확정 — 리프 임베드 + 폴백).
 *
 * **이 파일이 비공개 API 접근을 전부 격리한다. 다른 곳에 늘리지 않는다.**
 * 1. `createDetachedLeaf()` — `WorkspaceLeaf` 생성자가 `obsidian.d.ts` 에 없다. 캐스팅 1지점.
 * 2. `readPropertiesInDocument()` — `Vault.getConfig` 가 공개 타입이 아니다. 안내 문구용 읽기 전용.
 *
 * 둘 다 실패해도 예외가 밖으로 나가지 않는다 — 1번이 실패하면 호출부가 새 탭으로 폴백하고,
 * 2번이 실패하면 안내를 생략한다. 근거는 [[스파이크- Bases 기술 판정]] 판정 ③.
 */
export interface NoteModalAction {
	mode: OpenMode;
	/** 툴팁·스크린리더용 전체 문구. */
	label: string;
	/** 버튼에 함께 찍는 짧은 문구. */
	shortLabel: string;
	icon: string;
}

type PropertiesInDocument = 'visible' | 'hidden' | 'source';

/**
 * @returns 모달을 실제로 띄웠으면 true. false 면 호출부가 폴백(새 탭)으로 내려가야 한다.
 *   실패를 모달을 연 뒤가 아니라 열기 전에 판정해, 깨진 모달이 잠깐 보이는 일이 없게 했다.
 */
export async function openNoteModal(
	app: App,
	file: TFile,
	actions: NoteModalAction[],
	onAction: (mode: OpenMode) => void
): Promise<boolean> {
	const leaf = createDetachedLeaf(app);
	if (!leaf) return false;

	try {
		await leaf.openFile(file, { active: false });
	} catch (error) {
		console.error('Bases Plus: opening the note inside a detached leaf failed.', error);
		detachQuietly(leaf);
		return false;
	}

	const viewEl = leaf.view?.containerEl;
	if (!viewEl) {
		console.error('Bases Plus: the detached leaf produced no view container.');
		detachQuietly(leaf);
		return false;
	}

	new NoteModal(app, file, leaf, viewEl, actions, onAction).open();
	return true;
}

class NoteModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly leaf: WorkspaceLeaf,
		private readonly viewEl: HTMLElement,
		private readonly actions: NoteModalAction[],
		private readonly onAction: (mode: OpenMode) => void
	) {
		super(app);
	}

	onOpen(): void {
		// 껍데기(헤더 한 줄·닫기 X 자리·액션 버튼)는 값 순서 대화상자와 공유한다 — 크기만 이쪽이 따로 정한다.
		this.modalEl.addClass('bases-plus-modal');
		this.modalEl.addClass('bases-plus-note-modal');
		// `setTitle()` 은 쓰지 않는다 — 코어 `.modal-header` 안에 갇히면 액션과 한 줄이 될 수 없다(디자인 A1).
		// 그래서 제목이 없는 경우에도 접근성 이름이 남도록 여기서 직접 건다.
		this.modalEl.setAttr('aria-label', this.file.basename);

		const { contentEl } = this;
		contentEl.empty();

		this.renderHeader(contentEl);
		this.renderPropertiesNotice(contentEl);

		// 편집기는 그대로 옮겨 붙인다. 본문·단축키·속성 편집이 전부 따라온다.
		contentEl.createDiv({ cls: 'bases-plus-modal-leaf' }).appendChild(this.viewEl);
	}

	onClose(): void {
		// 리스너는 contentEl 과 함께 사라지므로 registerDomEvent 대응이 따로 필요 없다(관2).
		this.contentEl.empty();
		detachQuietly(this.leaf);
	}

	/** 마크다운은 인라인 제목이 있어 생략, 그 외(.base 등)는 필요. 사용자가 인라인 제목을 꺼 뒀으면 마크다운도 필요하다. */
	private needsTitle(): boolean {
		if (this.file.extension !== 'md') return true;

		return readInlineTitle(this.app) === false;
	}

	/**
	 * 제목·액션·닫기 X 가 같은 행에 서는 헤더 한 줄. **액션이 없어도 행은 만든다** —
	 * 마크다운 모달과 `.base` 모달의 형태를 같게 유지하는 것이 이 규칙의 핵심이고, 다른 것은 제목 유무뿐이다.
	 */
	private renderHeader(contentEl: HTMLElement): void {
		const headerEl = contentEl.createDiv({ cls: 'bases-plus-modal-header' });

		// 마크다운은 본문에 인라인 제목이 있어 제목을 넣지 않는다 — 그래도 행 자체는 두 경우가 같다.
		if (this.needsTitle()) {
			headerEl.createDiv({ cls: 'bases-plus-modal-title', text: this.file.basename });
		}

		if (this.actions.length === 0) return;

		const barEl = headerEl.createDiv({ cls: 'bases-plus-modal-actions' });

		for (const action of this.actions) {
			// 아이콘만 두면 무슨 버튼인지 읽히지 않는다는 피드백이 있었다 — 코어 메뉴와 같은 아이콘에 같은 문구를 붙인다.
			const buttonEl = barEl.createEl('button', { cls: 'bases-plus-modal-action' });
			setIcon(buttonEl.createSpan({ cls: 'bases-plus-modal-action-icon' }), action.icon);
			buttonEl.createSpan({ text: action.shortLabel });
			setTooltip(buttonEl, action.label);
			buttonEl.setAttr('aria-label', action.label);
			buttonEl.addEventListener('click', () => {
				this.close();
				this.onAction(action.mode);
			});
		}
	}

	private renderPropertiesNotice(contentEl: HTMLElement): void {
		const setting = readPropertiesInDocument(this.app);
		if (setting !== 'hidden' && setting !== 'source') return;

		// 설정 값 이름도 화면 언어를 따른다 — 사용자는 설정 화면에서 옮겨진 말(숨김·원본)을 봤다.
		const label = setting === 'hidden' ? t('Hidden') : t('Source');

		contentEl.createDiv({
			cls: 'bases-plus-modal-notice',
			text: t(
				'Property editing is unavailable here because "Properties in document" is set to "{{setting}}". Change it to "Visible" in Settings and then Editor.',
				{ setting: label }
			),
		});
	}
}

/**
 * 워크스페이스에 붙지 않는 leaf 를 만든다. 공개 API 의 leaf 생성 메서드는 전부 워크스페이스에 붙어
 * 탭·창이 되므로 모달에는 쓸 수 없다(스파이크 판정 ③).
 */
function createDetachedLeaf(app: App): WorkspaceLeaf | null {
	try {
		const LeafConstructor = WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf;
		return new LeafConstructor(app);
	} catch (error) {
		console.error('Bases Plus: could not create a detached workspace leaf.', error);
		return null;
	}
}

function detachQuietly(leaf: WorkspaceLeaf): void {
	try {
		leaf.detach();
	} catch (error) {
		console.error('Bases Plus: detaching the modal leaf failed.', error);
	}
}

/**
 * "문서 내 제목 표시" 설정. 못 읽으면 null 이고, 그때는 켜져 있다고 보고 마크다운 제목을 생략한다(기본값이 켜짐).
 * `Vault.getConfig` 가 공개 타입이 아니라 위 readPropertiesInDocument 와 같은 캐스팅을 쓴다 — 이 파일이 그 접근을 전부 격리한다.
 */
function readInlineTitle(app: App): boolean | null {
	try {
		const vault = app.vault as unknown as { getConfig?(key: string): unknown };
		const value = vault.getConfig ? vault.getConfig('showInlineTitle') : null;

		return typeof value === 'boolean' ? value : null;
	} catch (error) {
		console.error('Bases Plus: could not read the "Show inline title" setting.', error);
		return null;
	}
}

/** 값을 못 읽으면 null — 안내를 띄우지 않을 뿐 모달은 정상 동작한다. 기본값은 'visible' 이다. */
function readPropertiesInDocument(app: App): PropertiesInDocument | null {
	try {
		const vault = app.vault as unknown as { getConfig?(key: string): unknown };
		const value = vault.getConfig ? vault.getConfig('propertiesInDocument') : null;

		return value === 'visible' || value === 'hidden' || value === 'source' ? value : null;
	} catch (error) {
		console.error('Bases Plus: could not read the "Properties in document" setting.', error);
		return null;
	}
}
