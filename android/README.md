# Android 客户端（DogeTerm）

把面板（`panel.doge-liang-space.uk`）和各节点终端打包成原生 Android 应用的极简 WebView 壳。
零第三方依赖（无 androidx），认证完全复用站点的 Cloudflare Access OTP 流程。

## 功能

- 启动即加载面板，从面板进入各节点终端 / 沙盒控制台
- 面板、`*.doge-liang-space.uk` 各节点、Access 登录页均在应用内导航；站外链接交给系统浏览器
- Access 会话 Cookie 持久化（`CookieManager.flush()`），168h 内免重复登录
- 文件上传（`<input type=file>` → 系统文件选择器，支持多选）
- 文件下载（DownloadManager 落到系统 Downloads 目录，自动附带 Access Cookie）
- 软键盘 `adjustResize`、深色主题、返回键 = 页面后退
- Verified App Links：在系统浏览器等外部应用点击 `*.doge-liang-space.uk` 链接
  （面板「高速」按钮、加速池链接、终端地址）直接跳入本应用，而非浏览器标签页

## 链接接管（App Links）

`AndroidManifest.xml` 以 `android:autoVerify` 声明接管 `doge-liang-space.uk`
及其全部子域的 https 链接。系统在安装 APK 时抓取
`https://doge-liang-space.uk/.well-known/assetlinks.json`（通配符主机按规范
验证 apex）核对签名指纹，验证通过后无需用户手动设置。

该验证文件由 panel Worker 提供：apex 路由 `doge-liang-space.uk/.well-known/*`
指向 panel，内容放 `wrangler.prod.toml` 的 `ASSETLINKS` 变量。指纹取自签名证书：

```bash
openssl pkcs12 -in keystore.p12 -passin pass:$PASS -nokeys -clcerts \
  | openssl x509 -fingerprint -sha256 -noout
```

注意：**换签名密钥时除卸载重装外，还须同步更新 `ASSETLINKS` 里的指纹并重新
部署 panel**，否则新装 APK 验证失败，链接会回落到浏览器打开。安装后可在
系统设置 → 应用 → DogeTerm → 默认打开 中确认验证状态。

## 构建与发布

日常发布走 GitHub Actions（本控制机磁盘装不下 Android SDK）：

```bash
gh workflow run android-apk.yml --ref main -f release_tag=android-v1.0.1
```

- 填 `release_tag`：构建签名 APK 并创建同名 GitHub Release（APK 挂在 Release assets）
- 留空：只构建、上传为 workflow artifact（预检用）

版本号在 `app/build.gradle` 的 `versionCode` / `versionName`，发新版前手动 +1。

## 签名

密钥不进仓库。CI 优先从 GitHub Secrets 读取；**两个 Secret 都未配置时降级为 CI 内生成一次性密钥**（APK 可正常安装使用，但每次发版签名不同，覆盖升级会因签名不一致失败，需卸载重装）。要固定签名，配置：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_B64` | PKCS12 keystore 的 base64（别名 `term`） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令（条目口令与之相同） |

keystore 由 openssl 生成（无需 Java）：

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 10950 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=DogeTerm Android"
openssl pkcs12 -export -inkey key.pem -in cert.pem -name term \
  -out keystore.p12 -passout "pass:$PASS"
```

**换签名 = 手机上必须卸载重装**，请离线备份 keystore 与口令。

## 本地构建（可选）

需要 JDK 17 + Android SDK（platform 34）：

```bash
cd android
ANDROID_KEYSTORE_FILE=/path/keystore.p12 ANDROID_KEYSTORE_PASSWORD=... ./gradlew assembleRelease
# 不设签名环境变量则产出未签名 APK
```
