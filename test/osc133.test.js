const { test } = require('node:test');
const assert = require('node:assert');
const { stripAnsi, coalesceLines, cleanCmd, createCapture } = require('../public/osc133');

const A = '\x1b]133;A\x07';
const B = '\x1b]133;B\x07';
const C = '\x1b]133;C\x07';
const D = (ec) => `\x1b]133;D;${ec}\x07`;

// 一次完整命令周期:提示符(A..B) 命令回显(B..C) 输出(C..D)
const cycle = (cmd, out, ec) => `${A}root@host:~# ${B}${cmd}\r\n${C}${out}${D(ec)}`;

test('完整周期切出块:命令/输出/退出码', () => {
  const cap = createCapture();
  cap.feed(cycle('echo hi', 'hi\r\n', 0));
  assert.equal(cap.blocks.length, 1);
  const b = cap.blocks[0];
  assert.equal(b.cmd, 'echo hi');
  assert.equal(coalesceLines(b.out), 'hi');
  assert.equal(b.exit, 0);
  assert.equal(cap.sawMarkers, true);
});

test('非零退出码', () => {
  const cap = createCapture();
  cap.feed(cycle('false', '', 1));
  assert.equal(cap.blocks[0].exit, 1);
});

test('首个提示符的 D(无 C 配对)被忽略', () => {
  const cap = createCapture();
  cap.feed(`${D(0)}${A}# ${B}`);
  assert.equal(cap.blocks.length, 0);
});

test('标记跨 chunk 任意切断仍正确', () => {
  const cap = createCapture();
  const s = cycle('ls -la', 'total 8\r\nfile1\r\n', 0);
  for (const ch of s) cap.feed(ch);           // 逐字符喂
  assert.equal(cap.blocks.length, 1);
  assert.equal(cap.blocks[0].cmd, 'ls -la');
  assert.equal(coalesceLines(cap.blocks[0].out), 'total 8\nfile1');
});

test('标记前的文本归旧 phase(同 chunk 内切换)', () => {
  const cap = createCapture();
  cap.feed(`${A}# ${B}pwd\r\n${C}/root\r\n${D(0)}`);
  assert.equal(cap.blocks[0].cmd, 'pwd');
  assert.equal(coalesceLines(cap.blocks[0].out), '/root');
});

test('Uint8Array 输入,多字节 UTF-8 跨 chunk 断字', () => {
  const cap = createCapture();
  const bytes = new TextEncoder().encode(cycle('echo 你好', '你好\r\n', 0));
  const mid = 12; // 任意切点
  cap.feed(bytes.slice(0, mid));
  cap.feed(bytes.slice(mid));
  assert.equal(cap.blocks.length, 1);
  assert.equal(coalesceLines(cap.blocks[0].out), '你好');
});

test('运行中块暴露为 active,D 后清空', () => {
  const cap = createCapture();
  cap.feed(`${A}# ${B}sleep 9\r\n${C}`);
  assert.ok(cap.active);
  assert.equal(cap.active.cmd, 'sleep 9');
  cap.feed(D(0));
  assert.equal(cap.active, null);
});

test('其它 OSC(52 剪贴板)不干扰块边界,展示时被剥掉', () => {
  const cap = createCapture();
  cap.feed(cycle('cat x', 'data\x1b]52;c;aGk=\x07more\r\n', 0));
  assert.equal(cap.blocks.length, 1);
  assert.equal(coalesceLines(cap.blocks[0].out), 'datamore');
});

test('ST(ESC\\)终止的 OSC 同样识别', () => {
  const cap = createCapture();
  cap.feed(`\x1b]133;A\x1b\\# \x1b]133;B\x1b\\x\r\n\x1b]133;C\x1b\\y\r\n\x1b]133;D;0\x1b\\`);
  assert.equal(cap.blocks.length, 1);
  assert.equal(cap.blocks[0].cmd, 'x');
  assert.equal(coalesceLines(cap.blocks[0].out), 'y');
});

test('输出超上限截断并打标,不再累积', () => {
  const cap = createCapture({ maxBlock: 10 });
  cap.feed(cycle('yes', 'aaaaaaaaaaaaaaaaaaaaaaaa', 0));
  const b = cap.blocks[0];
  assert.equal(b.truncated, true);
  assert.equal(b.out.length, 10); // 按剩余额度精确裁剪
});

test('块数量滚动上限', () => {
  const cap = createCapture({ maxBlocks: 3 });
  for (let i = 0; i < 5; i++) cap.feed(cycle(`cmd${i}`, `out${i}\r\n`, 0));
  assert.equal(cap.blocks.length, 3);
  assert.equal(cap.blocks[0].cmd, 'cmd2');
  assert.equal(cap.blocks[2].cmd, 'cmd4');
});

test('coalesceLines:\\r 覆写只留最后一段(进度条折叠)', () => {
  assert.equal(coalesceLines('10%\r20%\r100%\r\ndone'), '100%\ndone');
});

test('coalesceLines:\\b 退格删前一字符', () => {
  assert.equal(coalesceLines('abcd\b\bxy'), 'abxy');
});

test('cleanCmd:剥色彩序列、退格结算、多行归一', () => {
  assert.equal(cleanCmd('\x1b[32mgit\x1b[0m statusx\b \b\r\n'), 'git status');
});

test('stripAnsi:CSI/OSC/DCS/游离 BEL 全剥', () => {
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m\x1b]0;title\x07\x1bPtmux;x\x1b\\ok\x07'), 'redok');
});

test('onBlock 回调收到收束的块', () => {
  const cap = createCapture();
  const got = [];
  cap.onBlock((b) => got.push(b.cmd));
  cap.feed(cycle('uptime', 'ok\r\n', 0));
  assert.deepEqual(got, ['uptime']);
});

// —— 以下按 tmux 实测时序建模:passthrough 标记先于合帧重绘的文本到达 ——

test('tmux 时序:提示符漂进 B..C 段被剥掉', () => {
  const cap = createCapture();
  cap.feed(`${D(0)}${A}${B}\x1b(Broot@host:/root# ls /x\r\n${C}file1\r\n${D(0)}`);
  assert.equal(cap.blocks.length, 1);
  assert.equal(cap.blocks[0].cmd, 'ls /x');
  assert.equal(coalesceLines(cap.blocks[0].out), 'file1');
});

test('tmux 时序:B..C 只有提示符、回显漂进输出首行时恢复', () => {
  const cap = createCapture();
  cap.feed(`${D(0)}${A}${B}\x1b(Broot@host:/root#${C}\x1b(Becho hi\r\nhi\r\n${D(0)}`);
  assert.equal(cap.blocks.length, 1);
  assert.equal(cap.blocks[0].cmd, 'echo hi');
  assert.equal(coalesceLines(cap.blocks[0].out), 'hi');
});

test('tmux 时序:上一块输出迟到跨过 D,经下一个 C 回填', () => {
  const cap = createCapture();
  cap.feed(`${D(0)}${A}${B}root@h:~# echo block-one\r\n${C}${D(0)}`);
  cap.feed(`${A}${B}block-one\r\nroot@h:~# ls\r\n${C}file\r\n${D(0)}`);
  assert.equal(cap.blocks.length, 2);
  assert.equal(cap.blocks[0].cmd, 'echo block-one');
  assert.equal(coalesceLines(cap.blocks[0].out), 'block-one');
  assert.equal(cap.blocks[1].cmd, 'ls');
  assert.equal(coalesceLines(cap.blocks[1].out), 'file');
});

test('stripAnsi:ESC(B 字符集指定序列被剥', () => {
  assert.equal(stripAnsi('\x1b(Bhello\x1b(0x'), 'hellox');
});

test('含 # 的命令不被误当提示符剥掉', () => {
  const cap = createCapture();
  cap.feed(cycle('echo a#b c', 'a#b c\r\n', 0));
  assert.equal(cap.blocks[0].cmd, 'echo a#b c');
});

test('无标记流:不产块、sawMarkers=false、不吞正文', () => {
  const cap = createCapture();
  cap.feed('plain \x1b[32mcolored\x1b[0m text\r\n');
  assert.equal(cap.blocks.length, 0);
  assert.equal(cap.sawMarkers, false);
});
