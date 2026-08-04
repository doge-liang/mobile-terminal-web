const test = require('node:test');
const assert = require('node:assert');
const {
  parseFastHosts, parseFastPool, poolHosts, pickPairHost,
  cookieDomainFor, connectSrcDirective, attrEscape,
} = require('../lib/fast-pool');

test('parseFastHosts: 单值、多值、留白、空串', () => {
  assert.deepStrictEqual(parseFastHosts('term-fast.example.com:2096'), ['term-fast.example.com:2096']);
  assert.deepStrictEqual(
    parseFastHosts(' a.t2.example.com:2096 , B.t2.example.com:2096 ,, '),
    ['a.t2.example.com:2096', 'b.t2.example.com:2096'],
  );
  assert.deepStrictEqual(parseFastHosts(''), []);
  assert.deepStrictEqual(parseFastHosts(undefined), []);
});

test('parseFastPool: 取 origin、剔非法与非 https、去重', () => {
  assert.deepStrictEqual(
    parseFastPool('https://a.t2.example.com:2096,https://b.t2.example.com:2096/path?x=1'),
    ['https://a.t2.example.com:2096', 'https://b.t2.example.com:2096'],
  );
  assert.deepStrictEqual(parseFastPool('http://a.example.com,not-a-url,https://ok.example.com'), ['https://ok.example.com']);
  assert.deepStrictEqual(parseFastPool('https://a.example.com,https://a.example.com'), ['https://a.example.com']);
  assert.deepStrictEqual(parseFastPool(''), []);
});

test('poolHosts: origin 转 host:port,443 缺省端口', () => {
  assert.deepStrictEqual(
    poolHosts(['https://a.t2.example.com:2096', 'https://b.example.com']),
    ['a.t2.example.com:2096', 'b.example.com'],
  );
});

test('pickPairHost: 白名单命中才用请求值,否则回落首项', () => {
  const hosts = ['a.t2.example.com:2096', 'b.t2.example.com:2096'];
  const pool = ['c.t2.example.com:2096'];
  assert.strictEqual(pickPairHost('b.t2.example.com:2096', hosts, pool), 'b.t2.example.com:2096');
  assert.strictEqual(pickPairHost('B.T2.EXAMPLE.COM:2096', hosts, pool), 'b.t2.example.com:2096');
  assert.strictEqual(pickPairHost('c.t2.example.com:2096', hosts, pool), 'c.t2.example.com:2096');
  assert.strictEqual(pickPairHost('evil.example.org', hosts, pool), 'a.t2.example.com:2096');
  assert.strictEqual(pickPairHost('', hosts, pool), 'a.t2.example.com:2096');
  assert.strictEqual(pickPairHost(undefined, [], pool), 'c.t2.example.com:2096');
  assert.strictEqual(pickPairHost(undefined, [], []), '');
});

test('pickPairHost: 请求值绝不原样透出(仅白名单成员)', () => {
  const out = pickPairHost('a.t2.example.com:2096/pwn?x=', ['a.t2.example.com:2096'], []);
  assert.strictEqual(out, 'a.t2.example.com:2096');
});

test('cookieDomainFor: 后缀匹配才给 Domain,支持带点/带端口/大小写', () => {
  assert.strictEqual(cookieDomainFor('a.t2.example.com:2096', 't2.example.com'), 't2.example.com');
  assert.strictEqual(cookieDomainFor('a.t2.example.com:2096', '.t2.example.com'), 't2.example.com');
  assert.strictEqual(cookieDomainFor('T2.EXAMPLE.COM', 't2.example.com'), 't2.example.com');
  // 非池域名(遗留单通道)不匹配 -> null -> host-only Cookie,Phase 1 行为
  assert.strictEqual(cookieDomainFor('term-fast2.example.com:2096', 't2.example.com'), null);
  // 恶意同后缀字符串不是子域:evilt2.example.com !== *.t2.example.com
  assert.strictEqual(cookieDomainFor('evilt2.example.com', 't2.example.com'), null);
  assert.strictEqual(cookieDomainFor('a.t2.example.com', ''), null);
  assert.strictEqual(cookieDomainFor('', 't2.example.com'), null);
  assert.strictEqual(cookieDomainFor('[::1]:2096', 't2.example.com'), null);
});

test('connectSrcDirective: 空池退化为 self,有池追加 origin', () => {
  assert.strictEqual(connectSrcDirective([]), "connect-src 'self'");
  assert.strictEqual(
    connectSrcDirective(['https://a.t2.example.com:2096', 'https://b.t2.example.com:2096']),
    "connect-src 'self' https://a.t2.example.com:2096 https://b.t2.example.com:2096",
  );
});

test('attrEscape: 覆盖五个 HTML 特殊字符', () => {
  assert.strictEqual(attrEscape(`&"'<>`), '&amp;&quot;&#39;&lt;&gt;');
  assert.strictEqual(attrEscape('["https://a.example.com:2096"]'), '[&quot;https://a.example.com:2096&quot;]');
});
