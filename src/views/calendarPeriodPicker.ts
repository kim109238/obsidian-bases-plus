import { Modal, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../shared/i18n';

/**
 * 년·월 선택 창(마스터 1차 요청 — "2026년 8월 을 누르면 년과 월을 선택할 수 있는 창").
 *
 * `Menu` 가 아니라 `Modal` 인 이유는 고를 것이 **두 축**이기 때문이다. 메뉴는 한 줄짜리 목록이라
 * 년을 먼저 고르고 월을 다시 고르는 두 단계가 되는데, 달력에서 기간을 옮기는 일은 한 번에 끝나야 한다.
 *
 * 어휘는 전부 확정분이다 — 대화상자 껍데기는 값 순서·막대 색 대화상자와 같은 `.bases-plus-modal`,
 * 년 이동 버튼은 표 페이저 버튼, 월 이름은 `Intl` 이 내는 화면 언어 표기다. 공개 API 만 쓴다.
 */
export interface PeriodPickerRequest {
	app: App;
	locale: string;
	/** 지금 보고 있는 기간 — 이 년·월에 표시가 선다. */
	current: Date;
	onChoose(date: Date): void;
}

export function openPeriodPicker(request: PeriodPickerRequest): Modal {
	const modal = new PeriodPickerModal(request);
	modal.open();

	return modal;
}

class PeriodPickerModal extends Modal {
	private year: number;
	private yearEl: HTMLElement | null = null;
	private monthsEl: HTMLElement | null = null;

	constructor(private readonly request: PeriodPickerRequest) {
		super(request.app);
		this.year = request.current.getFullYear();
	}

	onOpen(): void {
		this.modalEl.addClass('bases-plus-modal');
		this.modalEl.addClass('bases-plus-period-modal');

		const { contentEl } = this;
		contentEl.empty();

		const headerEl = contentEl.createDiv({ cls: 'bases-plus-modal-header' });
		const navEl = headerEl.createDiv({ cls: 'bases-plus-period-nav' });

		this.createStep(navEl, 'lucide-chevron-left', t('Previous year'), -1);
		this.yearEl = navEl.createDiv({ cls: 'bases-plus-modal-title bases-plus-period-year' });
		this.createStep(navEl, 'lucide-chevron-right', t('Next year'), 1);

		this.monthsEl = contentEl.createDiv({ cls: 'bases-plus-period-months' });
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private createStep(parentEl: HTMLElement, icon: string, label: string, step: number): void {
		const el = parentEl.createEl('button', {
			cls: 'bases-plus-pager-button',
			attr: { type: 'button', 'aria-label': label },
		});
		setIcon(el, icon);
		el.addEventListener('click', () => {
			this.year += step;
			this.render();
		});
	}

	private render(): void {
		const monthsEl = this.monthsEl;
		if (!this.yearEl || !monthsEl) return;

		// 년 표기도 화면 언어를 따른다 — 축·기간 이름과 같은 규칙이다(확정 D3-B).
		this.yearEl.setText(format(this.request.locale, { year: 'numeric' }, new Date(this.year, 0, 1)));
		monthsEl.empty();

		for (let month = 0; month < 12; month++) {
			const date = new Date(this.year, month, 1);
			const el = monthsEl.createEl('button', {
				cls: 'bases-plus-period-month',
				text: format(this.request.locale, { month: 'short' }, date),
				attr: { type: 'button' },
			});

			el.toggleClass(
				'is-current',
				month === this.request.current.getMonth() && this.year === this.request.current.getFullYear()
			);
			// 고르는 순간 닫힌다 — 확인 버튼이 있는 화면은 이 플러그인에 하나도 없다(F3).
			el.addEventListener('click', () => {
				this.request.onChoose(date);
				this.close();
			});
		}
	}
}

function format(locale: string, options: Intl.DateTimeFormatOptions, date: Date): string {
	try {
		return new Intl.DateTimeFormat(locale, options).format(date);
	} catch (error) {
		return new Intl.DateTimeFormat(undefined, options).format(date);
	}
}
