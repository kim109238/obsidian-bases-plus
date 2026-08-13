/**
 * 날짜와 저장 문자열 사이의 변환만 맡는 층. DOM 도 옵시디언 API 도 모른다 —
 * 타임라인(막대 드래그)과 달력(항목 배치·빈 칸 클릭)이 **같은 규칙으로** 날짜를 읽고 써야 하기 때문이다.
 */

/** ISO 앞머리만 본다 — 시각·시간대가 붙어 있어도 같은 날 칸에 선다. */
export function parseDateText(text: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
	if (!match) return null;

	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

	return Number.isNaN(date.getTime()) ? null : date;
}

/** 프론트매터에 쓰는 날짜 문자열. 네이티브 날짜 속성과 같은 `YYYY-MM-DD` 다. */
export function formatDateText(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 원래 값이 시각까지 담고 있었으면 그 시각을 지킨다 — 날짜만 옮겼다고 시각이 사라지면 안 된다. */
export function formatLikeText(original: string, date: Date): string {
	const time = /^\d{4}-\d{2}-\d{2}([T ].+)$/.exec(original.trim());
	const iso = formatDateText(date);

	return time ? `${iso}${time[1]}` : iso;
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}
