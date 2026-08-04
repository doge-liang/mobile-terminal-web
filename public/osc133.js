/* OSC 133 流式解析与命令块捕获
   输入是到达客户端的原始终端字节流(chunk 可在任意字节处切断,含跨 chunk 的
   转义序列与多字节 UTF-8)。逐字符状态机切出 OSC 133 标记,其余文本按当前
   状态路由:B→C 之间是命令回显、C→D 之间是输出;D 携带退出码收束成块。
   浏览器挂 window.MTBlocks;Node 走 module.exports 供单测。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MTBlocks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 剥掉 ANSI 转义(OSC/DCS 先于 CSI,避免半吞);ESC(B 这类带中间字节的
  // 字符集指定序列、游离 BEL 一并清掉
  function stripAnsi(s) {
    return String(s)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[ -/]+[0-~]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\x07/g, '');
  }

  // 终端语义的行折叠:\r\n 归一为 \n;行内 \r 是回车覆写(进度条),只留最后
  // 一段;\b 退格删前一字符。产出适合只读展示/复制的纯文本。
  function coalesceLines(raw) {
    const plain = stripAnsi(raw).replace(/\r\n/g, '\n');
    return plain.split('\n').map((line) => {
      const seg = line.split('\r').pop();
      let out = '';
      for (const ch of seg) {
        if (ch === '\b') out = out.slice(0, -1);
        else out += ch;
      }
      return out;
    }).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  }

  // 命令回显清洗:单行化 + 覆写/退格结算 + 去首尾空白
  function cleanCmd(raw) {
    return coalesceLines(raw).replace(/\n+/g, ' ').trim();
  }

  // tmux 实测(见 V1 集成验证):passthrough 标记即时转发、屏幕文本走合帧重绘,
  // 文本相对标记迟到、且迟到窗口可跨越 D——提示符/上一块输出会漂进 B..C 段、
  // 命令回显会漂进 C..D 段,抖动逐次不同。两层启发式修复:
  //  1. C 时刻按行拆 B..C 段:末行(剥提示符后)是命令,更早的行是上一块迟到的
  //     输出,回填给上一块;
  //  2. D 时刻若命令仍为空,取输出首行(迟到的回显)当命令并从输出剔除。
  function stripPrompt(cmd) {
    return cmd.replace(/^\S*[#$%](\s+|$)/, '');
  }
  function splitCmdBuf(raw) {
    const lines = coalesceLines(raw).split('\n');
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last < 0) return { cmd: '', late: '' };
    return {
      cmd: stripPrompt(lines[last].trim()),
      late: lines.slice(0, last).join('\n').replace(/\s+$/, ''),
    };
  }
  function recoverCmdFromOut(outRaw) {
    const lines = coalesceLines(outRaw).split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++; // 迟到重绘常带前导空行
    if (i >= lines.length) return null;
    return { cmd: stripPrompt(lines[i].trim()), out: lines.slice(i + 1).join('\n') };
  }

  // 文本相对标记的迟到可任意跨段(实测连 A/B 与提示符文本的先后都不可依赖),
  // 因此归因只锚定 C 和 D 两个标记:C 之前的一切文本进 preBuf,C 时按行拆分
  // (末行=命令,更早的行=上一块迟到的输出);C..D 之间进 outBuf。A/B 不参与分段。
  const S_GROUND = 0, S_ESC = 1, S_OSC = 2, S_OSC_ESC = 3;
  const PH_PRE = 0, PH_OUTPUT = 1;
  const OSC_MAX = 4096;        // 无终止符的畸形 OSC:超限当普通文本冲回
  const PRE_MAX = 64 * 1024;   // preBuf 可能装下整段迟到输出,给足余量

  function createCapture(opts) {
    const maxBlock = (opts && opts.maxBlock) || 200 * 1024;
    const maxBlocks = (opts && opts.maxBlocks) || 50;
    const blocks = [];
    const listeners = [];
    let decoder = null;          // Uint8Array 输入时惰性建,流式解码跨 chunk 多字节
    let state = S_GROUND;
    let osc = '';
    let phase = PH_PRE;
    let preBuf = '';
    let outBuf = '';
    let outLen = 0;
    let truncated = false;
    let sawC = false;            // D 只与 C 配对(首个提示符前的 D 忽略)
    let t0 = 0;

    const api = {
      blocks,
      sawMarkers: false,
      active: null,              // {cmd, t0}:C 之后、D 之前的运行中块
      onBlock(cb) { listeners.push(cb); },
      reset() {
        state = S_GROUND; osc = ''; phase = PH_PRE;
        preBuf = ''; outBuf = ''; outLen = 0; truncated = false; sawC = false;
        api.active = null;
      },
      feed,
    };

    function emitText(t) {
      if (!t) return;
      if (phase === PH_PRE) {
        if (preBuf.length < PRE_MAX) preBuf += t;
      } else {
        const room = maxBlock - outLen;
        if (room > 0) {
          const kept = t.length > room ? t.slice(0, room) : t;
          outBuf += kept;
          outLen += kept.length;
          if (t.length > room) truncated = true;
        } else {
          truncated = true;
        }
      }
    }

    function marker(payload) {
      api.sawMarkers = true;
      const kind = payload[0];
      const arg = payload.length > 2 ? payload.slice(2) : '';
      if (kind === 'C') {
        phase = PH_OUTPUT;
        sawC = true;
        const r = splitCmdBuf(preBuf);
        if (r.late && blocks.length) {
          // 迟到跨过了上一个 D 的输出:回填上一块,其命令若也因迟到为空则一并恢复
          const prev = blocks[blocks.length - 1];
          prev.out += (prev.out && !prev.out.endsWith('\n') ? '\n' : '') + r.late;
          if (!prev.cmd) {
            const rec = recoverCmdFromOut(prev.out);
            if (rec) { prev.cmd = rec.cmd; prev.out = rec.out; }
          }
        }
        preBuf = '';
        outBuf = ''; outLen = 0; truncated = false;
        t0 = Date.now();
        api.active = { cmd: r.cmd, t0 };
      } else if (kind === 'D') {
        if (sawC && phase === PH_OUTPUT) {
          let cmd = api.active ? api.active.cmd : '';
          let out = outBuf;
          if (!cmd) {
            const rec = recoverCmdFromOut(outBuf);
            if (rec) { cmd = rec.cmd; out = rec.out; }
          }
          const b = {
            cmd,
            out,
            truncated,
            exit: arg === '' ? null : parseInt(arg, 10),
            t0,
            t1: Date.now(),
          };
          blocks.push(b);
          if (blocks.length > maxBlocks) blocks.shift();
          for (const cb of listeners) { try { cb(b); } catch { /* 监听者异常不打断解析 */ } }
        }
        api.active = null;
        phase = PH_PRE;          // D 之后直到下个 C,文本都进 preBuf 等待拆分
      }
      // A/B 与其余扩展标记不参与分段(时序不可依赖),仅作 sawMarkers 能力探测
    }

    // 非 133 的完整 OSC 原样属于文本流(如 OSC 52/标题),交回捕获、展示时再剥
    function flushOscAsText(terminator) {
      emitText('\x1b]' + osc + terminator);
      osc = '';
    }

    function feed(data) {
      let text;
      if (typeof data === 'string') {
        text = data;
      } else {
        if (!decoder) decoder = new (typeof TextDecoder !== 'undefined' ? TextDecoder : require('util').TextDecoder)();
        text = decoder.decode(data, { stream: true });
      }
      let plain = '';           // 当前 chunk 里累积的普通文本,批量交给 emitText
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (state === S_GROUND) {
          if (ch === '\x1b') { state = S_ESC; } else { plain += ch; }
        } else if (state === S_ESC) {
          if (ch === ']') { state = S_OSC; osc = ''; }
          else { plain += '\x1b' + ch; state = S_GROUND; }
        } else if (state === S_OSC) {
          if (ch === '\x07') {
            state = S_GROUND;
            // 标记会切换 phase:之前累积的文本属于旧 phase,必须先冲洗
            emitText(plain); plain = '';
            if (osc.startsWith('133;')) marker(osc.slice(4));
            else flushOscAsText('\x07');
            osc = '';
          } else if (ch === '\x1b') {
            state = S_OSC_ESC;
          } else {
            osc += ch;
            if (osc.length > OSC_MAX) { emitText(plain); plain = ''; flushOscAsText(''); state = S_GROUND; }
          }
        } else { // S_OSC_ESC:OSC 内遇 ESC,只有 ESC\ 是合法终止
          if (ch === '\\') {
            state = S_GROUND;
            emitText(plain); plain = '';
            if (osc.startsWith('133;')) marker(osc.slice(4));
            else flushOscAsText('\x1b\\');
            osc = '';
          } else {
            osc += '\x1b' + ch;
            state = S_OSC;
          }
        }
      }
      emitText(plain);
      return api;
    }

    return api;
  }

  return { stripAnsi, coalesceLines, cleanCmd, createCapture };
});
