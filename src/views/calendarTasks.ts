/**
 * 노트 본문의 태스크를 모아 온다 — **Tasks 플러그인 캐시 우선 + 자체 파서 폴백**(마스터 확정 2026-08-06).
 * 판정 정본은 [[기술 판정- Bases 확장#달력 tasks 표시 판정]].
 *
 * 옵시디언 비공개 API 는 0지점이다. 태스크의 존재·상태는 메타데이터 캐시(`listItems`)가 주고,
 * 기한·설명은 본문을 읽어 우리가 판다 — **코어 자신이 같은 방식을 쓴다**(오프셋 1607300 부근).
 *
 * Tasks 는 의존이 아니라 최적화다. 지워도 기능이 죽지 않는다.
 */
import type { App, CachedMetadata, Events, EventRef, TFile } from 'obsidian';
import type { TaskStatus } from './calendarGrid';
import { parseDateText } from './dateText';

export interface CalendarTask {
	path: string;
	/** 1부터 세는 줄 번호. 같은 파일의 태스크를 구분하는 열쇠다. */
	line: number;
	status: TaskStatus;
	text: string;
	due: Date;
}

/**
 * Tasks 가 캐시를 갱신할 때 쏘는 이벤트와, 지금 스냅숏을 달라고 우리가 쏘는 이벤트.
 * 둘 다 `app.workspace`(공개 `Events`) 위에서 오간다 — `app.plugins` 를 쓰지 않는 이유다(판정 ③).
 */
const TASKS_CACHE_EVENT = 'obsidian-tasks-plugin:cache-update';
const TASKS_REQUEST_EVENT = 'obsidian-tasks-plugin:request-cache-update';

/**
 * Tasks 가 없으면 **응답이 아예 안 온다** — 예외도 오류도 없다(함정 D). 짧게 기다렸다가 자체 파서로 내려간다.
 * 200ms 는 이미 메모리에 있는 스냅숏을 돌려주는 동기 콜백에는 충분하고, 없을 때 화면이 비어 보이지 않을
 * 만큼 짧다(태스크가 오기 전에는 파일 칩만 그린다).
 */
const TASKS_PROBE_TIMEOUT = 200;

interface CachedFileTasks {
	mtime: number;
	tasks: CalendarTask[];
}

/**
 * 뷰가 하나씩 갖는 수집기. **선수집 후 렌더 2단**을 위한 것이라 렌더 안에서 기다리지 않는다 —
 * 렌더 중에 `await` 하면 화면이 비었다 채워지거나 갱신이 겹칠 때 순서가 뒤집힌다(함정 C).
 */
export class CalendarTaskSource {
	/** Tasks 가 준 스냅숏. null 이면 아직 모르거나 Tasks 가 없다. */
	private snapshot: Map<string, CalendarTask[]> | null = null;
	private probed = false;
	private probing: Promise<void> | null = null;
	/** 자체 파서 결과 — 파일 수정 시각으로 무효화한다(성1 · 판정 ④). */
	private readonly parsed = new Map<string, CachedFileTasks>();
	private ref: EventRef | null = null;

	constructor(
		private readonly app: App,
		/** Tasks 캐시가 갱신됐을 때 뷰를 다시 그리게 하는 통로. */
		private readonly onUpdate: () => void
	) {}

	unload(): void {
		if (!this.ref) return;

		(this.app.workspace as unknown as Events).offref(this.ref);
		this.ref = null;
	}

	/**
	 * 파일들의 태스크. **비동기다** — 뷰는 결과가 오면 다시 그린다.
	 * 기한이 없는 태스크는 놓을 칸이 없어 버린다.
	 */
	async collect(files: TFile[]): Promise<Map<string, CalendarTask[]>> {
		await this.probe();

		const out = new Map<string, CalendarTask[]>();

		for (const file of files) {
			const tasks = this.snapshot
				? this.snapshot.get(file.path) ?? []
				: await this.parse(file);

			if (tasks.length > 0) out.set(file.path, tasks);
		}

		return out;
	}

	/**
	 * Tasks 가 듣고 있는지 한 번만 물어본다. 응답이 오면 그 뒤로는 갱신 이벤트로 스냅숏을 갈아 끼운다.
	 *
	 * `Workspace` 가 자기 이벤트 이름 오버로드를 선언해 두어 임의 문자열을 넣으려면 `Events` 로
	 * 업캐스트해야 한다 — **공개 상위 클래스로의 타입 수준 업캐스트**이지 비공개 접근이 아니다(판정 ③).
	 */
	private probe(): Promise<void> {
		if (this.probed) return Promise.resolve();
		if (this.probing) return this.probing;

		const events = this.app.workspace as unknown as Events;

		this.probing = new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;

				settled = true;
				this.probed = true;
				this.probing = null;
				resolve();
			};

			const timer = setTimeout(finish, TASKS_PROBE_TIMEOUT);

			try {
				this.ref = events.on(TASKS_CACHE_EVENT, (payload: unknown) => {
					this.snapshot = groupTasks(payload);
					if (settled) this.onUpdate();
				});

				events.trigger(TASKS_REQUEST_EVENT, (payload: unknown) => {
					this.snapshot = groupTasks(payload);
					clearTimeout(timer);
					finish();
				});
			} catch (error) {
				console.error('Bases Plus: asking the Tasks plugin for its cache failed.', error);
				clearTimeout(timer);
				finish();
			}
		});

		return this.probing;
	}

	/**
	 * 자체 파서 경로. **체크박스가 있는 파일만 읽는다** — 메타데이터 캐시로 먼저 걸러 내면 본문 읽기가
	 * 태스크가 있는 파일 수만큼으로 줄어든다(성1). 읽은 결과는 수정 시각이 같은 동안 다시 쓴다.
	 */
	private async parse(file: TFile): Promise<CalendarTask[]> {
		const cache = this.app.metadataCache.getFileCache(file);
		const lines = taskLines(cache);
		if (lines.length === 0) {
			this.parsed.delete(file.path);
			return [];
		}

		const mtime = mtimeOf(file);
		const cached = this.parsed.get(file.path);
		if (cached && cached.mtime === mtime) return cached.tasks;

		let text = '';
		try {
			text = await this.app.vault.cachedRead(file);
		} catch (error) {
			console.error('Bases Plus: reading a note for its tasks failed.', error);
			return [];
		}

		const rows = text.split('\n');
		const tasks: CalendarTask[] = [];

		for (const line of lines) {
			const parsed = parseTaskLine(rows[line] ?? '');
			if (!parsed || !parsed.due) continue;

			tasks.push({ path: file.path, line: line + 1, ...parsed, due: parsed.due });
		}

		this.parsed.set(file.path, { mtime, tasks });

		return tasks;
	}
}

/**
 * 태스크 줄 하나를 읽는다. 지원 표기는 **이모지만**이다(마스터 확정) — dataview 인라인 필드(`due::`)를
 * 쓰는 줄은 기한이 안 잡혀 달력에 안 나온다. 그 한계는 뷰 옵션 설명에 적혀 있다(함정 B).
 */
export function parseTaskLine(line: string): { status: TaskStatus; text: string; due: Date | null } | null {
	const match = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$/.exec(line);
	if (!match) return null;

	const body = match[2];
	const due = parseDueDate(body);

	return { status: taskStatusOf(match[1]), text: cleanTaskText(body), due };
}

/**
 * 상태 문자는 **이진이 아니다**(함정 A). 마스터 볼트에 `- [-]` 취소가 실사용 중이라
 * `[x]` 만 완료로 보면 취소된 일이 달력에 살아 있는 일로 남는다.
 *
 * 완료·취소만 **적어 둔 대로** 판정하고 나머지는 전부 미완이다 — 모르는 표기(`/`·`>` 등)를 완료 쪽에
 * 두면 지나간 일로 보여 조용히 사라진다. 미완 쪽이 안전한 기본값이다.
 */
export function taskStatusOf(symbol: string): TaskStatus {
	if (symbol === 'x' || symbol === 'X') return 'done';
	if (symbol === '-') return 'cancelled';

	return 'todo';
}

/** 기한은 📅 뒤의 `YYYY-MM-DD` 다. 다른 이모지 날짜(🛫 시작 · ⏳ 예정 · ✅ 완료)는 배치에 쓰지 않는다. */
function parseDueDate(text: string): Date | null {
	const match = /📅\s*(\d{4}-\d{2}-\d{2})/.exec(text);

	return match ? parseDateText(match[1]) : null;
}

/**
 * 화면에 쓸 설명. 이모지와 그 뒤 날짜, 우선순위·반복 기호, 블록 참조를 떼어 낸다 —
 * 칸이 좁아 기호까지 실으면 정작 무슨 일인지가 안 보인다.
 */
function cleanTaskText(text: string): string {
	return text
		.replace(/[📅🛫➕⏳✅❌🔁🆔⛔]\s*\S*/gu, ' ')
		.replace(/[🔺⏫🔼🔽⏬]/gu, ' ')
		.replace(/\s*\^[A-Za-z0-9-]+\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** 태스크인 줄 번호(0부터). `task` 가 `undefined` 가 아니면 태스크다(d.ts L3759). */
function taskLines(cache: CachedMetadata | null): number[] {
	const items = cache?.listItems ?? [];
	const out: number[] = [];

	for (const item of items) {
		if (typeof item.task === 'string') out.push(item.position.start.line);
	}

	return out;
}

function mtimeOf(file: TFile): number {
	const stat = (file as unknown as { stat?: { mtime?: unknown } }).stat;

	return typeof stat?.mtime === 'number' ? stat.mtime : 0;
}

/**
 * Tasks 가 준 스냅숏을 파일 경로별로 묶는다. **서드파티 내부 계약이라 전부 능력으로 확인한다** —
 * 모양이 바뀌면 그 태스크만 조용히 빠지고 화면은 선다.
 */
function groupTasks(payload: unknown): Map<string, CalendarTask[]> {
	const list = (payload as { tasks?: unknown } | null)?.tasks;
	const out = new Map<string, CalendarTask[]>();
	if (!Array.isArray(list)) return out;

	for (const raw of list) {
		const task = readPluginTask(raw);
		if (!task) continue;

		const bucket = out.get(task.path);
		if (bucket) bucket.push(task);
		else out.set(task.path, [task]);
	}

	return out;
}

function readPluginTask(raw: unknown): CalendarTask | null {
	const task = raw as {
		dueDate?: unknown;
		description?: unknown;
		status?: { symbol?: unknown; type?: unknown };
		taskLocation?: { path?: unknown; lineNumber?: unknown; _path?: unknown };
		path?: unknown;
		lineNumber?: unknown;
	} | null;
	if (!task) return null;

	const due = readMomentDate(task.dueDate);
	const path = firstString(task.taskLocation?.path, task.taskLocation?._path, task.path);
	if (!due || !path) return null;

	return {
		path,
		line: typeof task.lineNumber === 'number' ? task.lineNumber : numberOr(task.taskLocation?.lineNumber, 0),
		status: pluginStatusOf(task.status),
		text: typeof task.description === 'string' ? task.description : '',
		due,
	};
}

/**
 * Tasks 는 상태를 객체로 준다. 기호가 있으면 우리 판정을 그대로 쓰고(같은 규칙이 한 곳에만 있게),
 * 없으면 종류 문자열로 떨어진다.
 */
function pluginStatusOf(status: { symbol?: unknown; type?: unknown } | undefined): TaskStatus {
	if (typeof status?.symbol === 'string' && status.symbol !== '') return taskStatusOf(status.symbol);

	const type = typeof status?.type === 'string' ? status.type.toUpperCase() : '';
	if (type === 'DONE') return 'done';
	if (type === 'CANCELLED') return 'cancelled';

	return 'todo';
}

/** Tasks 의 날짜는 moment 객체다 — `toDate()` 가 있으면 쓰고, 문자열이면 앞머리를 판다. */
function readMomentDate(value: unknown): Date | null {
	const candidate = value as { toDate?: () => Date; format?: (pattern: string) => string } | null;
	if (!candidate) return null;

	try {
		if (typeof candidate.format === 'function') return parseDateText(candidate.format('YYYY-MM-DD'));
		if (typeof candidate.toDate === 'function') {
			const date = candidate.toDate();

			return date instanceof Date && !Number.isNaN(date.getTime())
				? new Date(date.getFullYear(), date.getMonth(), date.getDate())
				: null;
		}
	} catch (error) {
		return null;
	}

	return typeof value === 'string' ? parseDateText(value) : null;
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value !== '') return value;
	}

	return null;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' ? value : fallback;
}
