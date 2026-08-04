'use strict';
const path = require('path');

// 删除前的静态防线:只看路径、不碰文件系统。返回 { path } 或 { error }。
// 拒删的三类:根目录、$HOME 与应用目录这类"删了就回不来"的祖先、以及显式保护的单个文件。
// 先 resolve 再比较——否则 /root/../root/.auth-secret 这类写法能绕过字符串比对。
function resolveDeletable(target, { home, cwd, protect = [] } = {}) {
  if (typeof target !== 'string' || !target.trim()) return { error: '缺少路径' };
  if (target.includes('\0')) return { error: '路径非法' };
  if (!path.isAbsolute(target)) return { error: '需要绝对路径' };

  const p = path.resolve(target);
  if (p === path.parse(p).root) return { error: '不能删除根目录' };
  if (home && p === path.resolve(home)) return { error: '不能删除主目录' };

  // cwd 及其任一祖先:删掉会连带端掉正在跑的服务本身
  if (cwd) {
    const c = path.resolve(cwd);
    if (c === p || c.startsWith(p + path.sep)) return { error: '不能删除服务运行目录或其上级' };
  }
  for (const guarded of protect) {
    if (p === path.resolve(guarded)) return { error: '该文件受保护,不可删除' };
  }
  return { path: p };
}

module.exports = { resolveDeletable };
