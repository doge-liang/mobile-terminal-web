package uk.dogeliangspace.term;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 单 WebView 壳：加载启动面板，面板/终端/Cloudflare Access 登录都在应用内完成。
 * 无第三方依赖，认证完全复用站点的 Access OTP 流程（Cookie 持久化在 WebView）。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1;
    private static final int REQ_WRITE_PERMISSION = 2;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    // API <= 28 下载需先申请存储权限，暂存请求参数等回调后重放
    private String pendingDlUrl, pendingDlUa, pendingDlDisposition, pendingDlMime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0D1117);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        // 站点自带字号调节，禁用系统缩放避免双指手势与终端冲突
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isInternalHost(uri)) {
                    return false;
                }
                // 站外链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 尽快持久化 Access 会话 Cookie，防止进程被杀后重新登录
                CookieManager.getInstance().flush();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 渲染进程崩溃时重建 Activity，避免整个应用被拉死
                recreate();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, getString(R.string.file_chooser_title)),
                            REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                    && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                       != PackageManager.PERMISSION_GRANTED) {
                pendingDlUrl = url;
                pendingDlUa = userAgent;
                pendingDlDisposition = contentDisposition;
                pendingDlMime = mimeType;
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        REQ_WRITE_PERMISSION);
                return;
            }
            enqueueDownload(url, userAgent, contentDisposition, mimeType);
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(getString(R.string.home_url));
        }
    }

    /** 面板、各节点终端、快速通道与 Access 登录页都留在应用内。 */
    private boolean isInternalHost(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        return host.endsWith(".doge-liang-space.uk")
                || host.equals("doge-liang-space.uk")
                || host.endsWith(".cloudflareaccess.com");
    }

    private void enqueueDownload(String url, String userAgent, String contentDisposition,
                                 String mimeType) {
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            // 下载走 DownloadManager 独立进程，需手动带上 WebView 里的 Access 会话 Cookie
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) {
                req.addRequestHeader("Cookie", cookies);
            }
            req.addRequestHeader("User-Agent", userAgent);
            req.setMimeType(mimeType);
            req.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_WRITE_PERMISSION && pendingDlUrl != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                enqueueDownload(pendingDlUrl, pendingDlUa, pendingDlDisposition, pendingDlMime);
            } else {
                Toast.makeText(this, R.string.download_need_permission, Toast.LENGTH_LONG).show();
            }
            pendingDlUrl = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
