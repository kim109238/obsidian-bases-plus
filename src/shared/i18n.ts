import { getLanguage } from 'obsidian';

/**
 * 화면 문구 번역. **영어가 원문이자 키**다 — 키를 따로 만들면 코드에서 문구를 읽을 수 없게 되고,
 * 사전에 빠진 자리가 조용히 빈 문자열이 된다. 여기서는 못 찾으면 원문(영어)이 그대로 나온다.
 *
 * 옮기는 것은 **우리가 만든 컨트롤 문구뿐**이다. 저장 값(`.base` 에 적히는 뷰 옵션 값)·config 키·클래스명은
 * 번역하지 않는다 — 화면 글자만 바뀌고 파일에 적히는 것은 언어와 무관하게 같아야 한다.
 *
 * 이미 화면 언어를 따르는 자리(날짜 축 문구·기간 이름)는 `Intl` 이 맡고 여기 오지 않는다.
 */

/** 사전이 있는 언어. 여기 없으면 원문(영어)이 나온다. */
const DICTIONARIES: Record<string, Record<string, string>> = { ko: {} };

/**
 * 한국어 사전.
 *
 * 어휘는 **옵시디언 한국어 UI 를 따랐다**(설치본 1.13.6 의 `i18n/ko.txt`·`mapping.txt` 대조) —
 * 속성·필터·정렬·그룹 기준·없음·베이스·항목·행·모두 표시하기·확대·축소·오늘이 전부 코어가 쓰는 말이다.
 * 우리가 새로 지은 말은 코어에 없는 것(막대·창·솎기 계열)뿐이다.
 */
const KO: Record<string, string> = {
	// ── 뷰 이름 (Bases 뷰 종류 목록에 선다) ─────────────────────────────────────
	// 코어가 표·카드·목록으로 번역하므로 우리 것만 영어로 남으면 목록이 섞인다.
	'Plus table': '플러스 표',
	'Plus timeline': '플러스 타임라인',
	'Plus calendar': '플러스 달력',
	'Plus graph': '플러스 그래프',

	// ── 열기 계층 ───────────────────────────────────────────────────────────────
	'Open with Bases Plus': 'Bases Plus 로 열기',
	'Open in modal': '모달로 열기',
	'Open in new tab': '새 탭에서 열기',
	'Open in new window': '새 창에서 열기',
	Modal: '모달',
	'New tab': '새 탭',
	'New window': '새 창',
	'Bases Plus could not open a modal. Opening a new tab instead.':
		'Bases Plus 가 모달을 열지 못해 새 탭으로 엽니다.',

	// ── 표 뷰 ───────────────────────────────────────────────────────────────────
	'Open rows with': '행 열기 방식',
	'Row limit': '행 제한',
	'Rows per page': '페이지당 행 수',
	'Rows per group': '그룹당 행 수',
	'Manual order': '수동 순서',
	'Group manual order': '그룹 수동 순서',
	'Show all': '모두 표시하기',
	Pages: '페이지',
	'Top rows per group': '그룹마다 위에서 몇 행',
	'Pages per group': '그룹마다 페이지',
	'Show all ({{count}})': '모두 표시하기 ({{count}})',
	'Set value order...': '값 순서 정하기...',
	'Manual order is paused while a sort is active. Clear the sort to reorder rows.':
		'정렬이 켜져 있는 동안에는 수동 순서가 멈춥니다. 순서를 바꾸려면 정렬을 지우세요.',
	'Group paging needs a group. Choose Group by in the toolbar.':
		'그룹 페이지는 그룹이 있어야 합니다. 툴바에서 그룹 기준을 정하세요.',

	// ── 페이저 ──────────────────────────────────────────────────────────────────
	'Previous page': '이전 페이지',
	'Next page': '다음 페이지',
	'Page number': '페이지 번호',
	'Page {{page}} of {{count}}': '{{count}} 페이지 중 {{page}}',

	// ── 값 순서·색 대화상자 ─────────────────────────────────────────────────────
	'Reset order': '순서 재설정',
	'Reorder value': '값 순서 바꾸기',
	'Reset colors': '색 재설정',
	'Color {{index}}': '색 {{index}}',
	'No values yet. Values appear here once notes in this base use this property.':
		'아직 값이 없습니다. 이 베이스의 노트가 이 속성을 쓰면 여기에 나타납니다.',
	'No values yet': '아직 값이 없습니다',

	// ── 타임라인 ────────────────────────────────────────────────────────────────
	'Start date': '시작 날짜',
	'End date': '종료 날짜',
	'Color by': '색 기준',
	'Bar label': '막대 글자',
	'Zoom out': '축소',
	'Zoom in': '확대',
	'Zoom level': '배율',
	Today: '오늘',
	'Bar colors': '막대 색',
	'New item': '항목 추가',
	Day: '일',
	Week: '주',
	Month: '월',
	Quarter: '분기',
	Year: '년',
	'Choose a start date property to draw the timeline.': '타임라인을 그리려면 시작 날짜 속성을 정하세요.',

	// ── 달력 ────────────────────────────────────────────────────────────────────
	View: '보기',
	'Items per day': '날짜당 항목 수',
	'Week starts on': '주 시작 요일',
	Sunday: '일요일',
	Monday: '월요일',
	'Wrap item text': '항목 글자 줄바꿈',
	'Show tasks': '태스크 표시',
	'Properties in item': '항목 안 속성',
	'Name and value': '이름과 값',
	'Values only': '값만',
	'Show empty properties': '빈 속성 표시',
	'Checkbox before title': '제목 앞 체크박스',
	'Checkbox on notes without it': '속성이 없는 노트에도 체크박스',
	'Editable property': '수정할 속성',
	'Open items with': '항목 열기 방식',
	'Previous period': '이전 기간',
	'Next period': '다음 기간',
	'Choose month': '월 고르기',
	'Previous year': '이전 해',
	'Next year': '다음 해',
	'Item colors': '항목 색',
	'New item on this day': '이 날짜에 항목 추가',
	'Toggle checkbox': '체크박스 켜기/끄기',
	'Change value': '값 바꾸기',
	'Choose a start date property to draw the calendar.': '달력을 그리려면 시작 날짜 속성을 정하세요.',
	'This calendar is taller than the embed. Set a height on the embed or use week view.':
		'달력이 임베드보다 높습니다. 임베드에 높이를 주거나 주 보기를 쓰세요.',

	// ── 그래프 ──────────────────────────────────────────────────────────────────
	'X property': 'X 속성',
	'X window': 'X 창',
	All: '전체',
	Units: '단위',
	'Show dots': '점 표시',
	Always: '항상',
	'On hover': '마우스 올릴 때',
	Auto: '자동',
	'Missing values': '값 없는 지점',
	'Break line': '선 끊기',
	Connect: '잇기',
	'Open points with': '점 열기 방식',
	'Show {{name}}': '{{name}} 표시',
	'Hide {{name}}': '{{name}} 감추기',
	'Choose an X and Y property to draw the graph.': '그래프를 그리려면 X 속성과 Y 속성을 정하세요.',
	'No numeric values to plot in the selected Y properties.': '고른 Y 속성에 그릴 숫자 값이 없습니다.',
	'1 row has no X value and is not drawn.': 'X 값이 없는 행 1개는 그리지 않았습니다.',
	'{{count}} rows have no X value and are not drawn.': 'X 값이 없는 행 {{count}}개는 그리지 않았습니다.',

	// ── 뷰 껍데기 ───────────────────────────────────────────────────────────────
	'Bases Plus could not render this view. Open the developer console for the reason.':
		'Bases Plus 가 이 뷰를 그리지 못했습니다. 이유는 개발자 콘솔에서 볼 수 있습니다.',

	// ── 모달 안내 ───────────────────────────────────────────────────────────────
	// 설정 이름·값은 옵시디언 한국어 UI 의 말을 그대로 쓴다(문서 내 속성 · 표시 · 숨김 · 원본).
	'Property editing is unavailable here because "Properties in document" is set to "{{setting}}". Change it to "Visible" in Settings and then Editor.':
		'여기서는 속성을 고칠 수 없습니다 — "문서 내 속성" 설정이 "{{setting}}" 이기 때문입니다. 설정의 편집기에서 "표시"로 바꾸세요.',
	Hidden: '숨김',
	Source: '원본',

	// ── 설정 탭 ─────────────────────────────────────────────────────────────────
	"Add an open item to Obsidian's own Bases views": 'Obsidian 기본 베이스 뷰에 열기 항목 추가',
	'Shows a "Bases Plus" item when you right-click a row in the built-in table, cards, and list views.':
		'기본 표·카드·목록 뷰에서 행을 우클릭하면 "Bases Plus" 항목이 나옵니다.',
	"Open mode for Obsidian's own Bases views": 'Obsidian 기본 베이스 뷰의 열기 방식',
	'How that item opens a note. Views added by this plugin ignore this and use their own view option in the Bases toolbar.':
		'그 항목이 노트를 어떻게 열지 정합니다. 이 플러그인이 추가한 뷰는 이 값을 쓰지 않고 베이스 툴바의 뷰 옵션을 씁니다.',
	'Default rows per page': '기본 페이지당 행 수',
	'Used by views that have no number of their own. Views with a number keep it.':
		'자기 값이 없는 뷰가 이 값을 씁니다. 값이 있는 뷰는 그대로 둡니다.',
	'Calendar tasks': '달력 태스크',
	'The calendar reads due dates written with the Tasks emoji syntax, like 📅 2026-08-06. Dates written as Dataview inline fields (due::) only show up when the Tasks plugin is installed.':
		'달력은 Tasks 이모지 문법으로 적은 기한을 읽습니다(예 📅 2026-08-06). Dataview 인라인 필드(due::)로 적은 날짜는 Tasks 플러그인이 설치돼 있을 때만 나옵니다.',
};

DICTIONARIES.ko = KO;

/**
 * 화면 언어. 공개 `getLanguage()` 가 정본이다(`@since 1.8.7` — 우리 `minAppVersion` 1.13.4 보다 낮아 늘 있다).
 * 없는 환경(하네스)에서는 옵시디언이 값을 넣어 두는 `localStorage` 를 읽어 같은 답을 얻는다.
 */
export function appLanguage(): string {
	try {
		const code = getLanguage();
		if (typeof code === 'string' && code !== '') return code;
	} catch (error) {
		// 아래 폴백으로 떨어진다.
	}

	try {
		return window.localStorage.getItem('language') || 'en';
	} catch (error) {
		return 'en';
	}
}

/**
 * 원문(영어)을 화면 언어로 옮긴다. 사전에 없으면 원문 그대로다 — **빠진 자리가 영어로 남지 빈칸이 되지 않는다.**
 *
 * @param vars `{{이름}}` 자리에 넣을 값. 코어 번역 파일과 같은 표기라 자리 이동이 자연스럽다
 *   (한국어는 수·단위가 뒤에 붙어 영어와 어순이 다르다).
 */
export function t(text: string, vars?: Record<string, string | number>): string {
	const dictionary = DICTIONARIES[appLanguage()];
	const template = (dictionary && dictionary[text]) || text;
	if (!vars) return template;

	return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
	);
}

/**
 * 드롭다운 선택지 표. **키는 저장 값이라 그대로 두고 보이는 글자만 옮긴다** —
 * 키를 번역하면 `.base` 에 한국어가 적혀 언어를 바꾼 순간 설정이 깨진다.
 */
export function translateChoices(choices: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};

	for (const key of Object.keys(choices)) out[key] = t(choices[key]);

	return out;
}

/** 사전에 실린 원문 목록. 커버리지 검사가 이 값을 쓴다. */
export function dictionaryKeys(language: string): string[] {
	return Object.keys(DICTIONARIES[language] ?? {});
}
