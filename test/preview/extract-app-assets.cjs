'use strict';
/**
 * 화면 실물 검증에 쓸 옵시디언 저작물(app.css·app.js)을 설치본에서 뽑아 `.assets/` 에 둔다.
 *
 * **뽑은 파일은 리포에 넣지 않는다** — 옵시디언 저작물이다. `.assets/` 는 .gitignore 대상이고,
 * 다른 머신·다른 버전에서는 이 스크립트를 다시 돌려 만든다.
 *
 *   node plugin/test/preview/extract-app-assets.cjs
 *   node plugin/test/preview/extract-app-assets.cjs /경로/obsidian-1.13.4.asar
 *
 * 기본 경로는 macOS 설치본이다: `~/Library/Application Support/obsidian/obsidian-<버전>.asar`
 * (같은 폴더에 여러 버전이 있으면 가장 최신 버전을 고른다). 다른 OS 면 asar 경로를 인자로 준다.
 *
 * asar 는 `[uint32 x4 헤더][JSON 인덱스][파일 본문]` 구조라 의존성 없이 읽을 수 있다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WANTED = ['app.css', 'app.js'];
const OUT_DIR = path.join(__dirname, '.assets');

function defaultAsarPath() {
	const dir = path.join(os.homedir(), 'Library', 'Application Support', 'obsidian');
	const files = fs
		.readdirSync(dir)
		.filter((name) => /^obsidian-.*\.asar$/.test(name))
		.sort();

	if (files.length === 0) throw new Error(`설치본 asar 을 못 찾았다: ${dir}`);

	return path.join(dir, files[files.length - 1]);
}

function extract(asarPath) {
	const fd = fs.openSync(asarPath, 'r');
	const head = Buffer.alloc(16);
	fs.readSync(fd, head, 0, 16, 0);

	const headerSize = head.readUInt32LE(12);
	const headerBuf = Buffer.alloc(headerSize);
	fs.readSync(fd, headerBuf, 0, headerSize, 16);

	const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
	// 본문 시작점은 헤더 뒤를 4바이트 경계로 올린 자리다.
	const base = 16 + Math.ceil(headerSize / 4) * 4;

	fs.mkdirSync(OUT_DIR, { recursive: true });

	for (const name of WANTED) {
		const entry = header.files[name];
		if (!entry) {
			console.log(`  건너뜀 ${name} (asar 에 없음)`);
			continue;
		}

		const buf = Buffer.alloc(Number(entry.size));
		fs.readSync(fd, buf, 0, Number(entry.size), base + Number(entry.offset));
		fs.writeFileSync(path.join(OUT_DIR, name), buf);
		console.log(`  ${name} ${entry.size} 바이트`);
	}

	fs.closeSync(fd);
}

const asarPath = process.argv[2] || defaultAsarPath();
console.log('추출:', asarPath, '→', OUT_DIR);
extract(asarPath);
