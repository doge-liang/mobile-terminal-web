'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEnvFile, parseNodesFile } = require('../box/lib/env');

test('parseEnvFile 解析 KEY=VALUE,忽略注释与空行,值可含 =', () => {
  const out = parseEnvFile('# c\nA=1\n\nB=x=y\n BAD_LINE \n');
  assert.deepStrictEqual(out, { A: '1', B: 'x=y' });
});

test('parseNodesFile 解析 名字+主机 两列', () => {
  const out = parseNodesFile('# 注释\nterm1 local\nterm2 my-second-node\n');
  assert.deepStrictEqual(out, [
    { name: 'term1', host: 'local' },
    { name: 'term2', host: 'my-second-node' },
  ]);
});
