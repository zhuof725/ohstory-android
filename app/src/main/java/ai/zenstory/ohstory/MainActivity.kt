package ai.zenstory.ohstory

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private var server: StoryServer? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.textZoom = 100
            webViewClient = WebViewClient()
            setBackgroundColor(0xFFFAF6EE.toInt())
        }
        setContentView(web)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            web.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(0, bars.top, 0, bars.bottom)
                insets
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }

        try {
            val s = StoryServer(applicationContext)
            s.start()
            server = s
            web.loadUrl("http://127.0.0.1:43113/")
        } catch (e: Exception) {
            web.loadData(
                "<html><body style='font:16px -apple-system;padding:40px;background:#faf6ee;color:#1f1c18'>" +
                    "<h3>服务启动失败</h3><p>${e.message}</p></body></html>",
                "text/html", "utf-8"
            )
        }
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        server?.stop()
        web.destroy()
        super.onDestroy()
    }
}
