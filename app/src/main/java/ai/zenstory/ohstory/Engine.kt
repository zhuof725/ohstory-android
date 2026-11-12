package ai.zenstory.ohstory

import android.content.Context
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import fi.iki.elonen.NanoHTTPD
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 原版引擎：把 oh-story 的 Python 脚本塞进 APK（Chaquopy），
 * 在手机上原样跑 build_writer_prompt / storyctl / tracking_commit。
 */
object Engine {

    private val lock = Object()
    @Volatile private var started = false
    @Volatile private var failure: String? = null
    lateinit var skills: File
        private set

    val ready: Boolean get() = started

    fun fail(e: Throwable) {
        failure = e.message ?: "引擎初始化失败"
        synchronized(lock) { lock.notifyAll() }
    }

    /** 等引擎就绪，最多等 timeoutMs */
    fun await(timeoutMs: Long = 30000): Boolean {
        if (started) return true
        if (failure != null) return false
        synchronized(lock) {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!started && failure == null) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) break
                lock.wait(left)
            }
        }
        return started
    }

    fun ensure(ctx: Context) {
        if (started) return
        if (!Python.isStarted()) Python.start(AndroidPlatform(ctx))
        skills = File(ctx.filesDir, "skills")
        if (!File(skills, "story-long-write/scripts/storyctl.py").exists()) {
            unzipSkills(ctx)
        }
        started = true
        synchronized(lock) { lock.notifyAll() }
    }

    /** assets/skills.zip → filesDir/skills */
    private fun unzipSkills(ctx: Context) {
        val dest = ctx.filesDir
        java.util.zip.ZipInputStream(ctx.assets.open("skills.zip")).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val out = File(dest, "skills/" + entry.name)
                if (entry.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    out.outputStream().use { zip.copyTo(it) }
                }
                zip.closeEntry()
            }
        }
    }

    fun script(skill: String, name: String) = File(skills, "$skill/scripts/$name")

    /** 执行 Python 脚本，返回 {"code": int, "out": str} */
    fun run(script: File, args: List<String> = emptyList(), cwd: File? = script.parentFile): JSONObject {
        val mod = Python.getInstance().getModule("runner")
        val raw = mod.callAttr("run", script.absolutePath, JSONArray(args).toString(), cwd?.absolutePath ?: "").toString()
        return try { JSONObject(raw) } catch (e: Exception) { JSONObject().put("code", 1).put("out", raw) }
    }

    fun out(res: JSONObject) = res.optString("out", "")
    fun code(res: JSONObject) = res.optInt("code", 1)

    /* ---------- 状态 ---------- */
    fun status(bookDir: File): JSONObject {
        val outlineFile = File(bookDir, "大纲/卷纲_第一卷.md")
        val outline = JSONObject()
        if (outlineFile.isFile) {
            val r = run(script("story-long-write", "outline_view.py"), listOf("--check", outlineFile.absolutePath), bookDir)
            val text = out(r)
            val m = Regex("段\\s*(\\d+)\\s*／\\s*问题\\s*(\\d+)\\s*／\\s*告警\\s*(\\d+)").find(text)
            outline.put("exists", true)
                .put("ok", code(r) == 0 && (m == null || m.groupValues[2].toInt() == 0))
                .put("summary", m?.let { "剧情段 ${it.groupValues[1]} · 问题 ${it.groupValues[2]} · 告警 ${it.groupValues[3]}" } ?: text.take(200))
        } else {
            outline.put("exists", false).put("ok", false).put("summary", "还没有卷纲")
        }

        val outlineDir = File(bookDir, "大纲")
        val outlines = JSONArray()
        outlineDir.listFiles { f -> f.name.matches(Regex("细纲_第\\d+章\\.md")) }
            ?.sortedBy { it.name }?.forEach { outlines.put(it.name) }

        val chapters = JSONArray()
        chapterFiles(bookDir).forEach { chapters.put(it.name) }

        return JSONObject()
            .put("outline", outline)
            .put("outlines", outlines)
            .put("chapters", chapters)
            .put("tracking", File(bookDir, "追踪/_tracking-state.json").isFile)
            .put("nextChapter", chapters.length() + 1)
            .put("benchmark", JSONObject.NULL)
            .put("files", JSONObject()
                .put("short", File(bookDir, "设定.md").isFile)
                .put("position", File(bookDir, "设定/题材定位.md").isFile)
                .put("setting", countMd(File(bookDir, "设定/角色")) + countMd(File(bookDir, "设定/世界观")))
                .put("proseCard", File(bookDir, "设定/题材正文提示卡.md").isFile))
    }

    private fun countMd(dir: File) = dir.listFiles { f -> f.name.endsWith(".md") }?.size ?: 0

    fun chapterFiles(dir: File): List<File> {
        val d = File(dir, "正文")
        if (!d.isDirectory) return emptyList()
        return d.listFiles { f -> f.isFile && (f.name.endsWith(".md") || f.name.endsWith(".txt")) }
            ?.sortedBy { it.name } ?: emptyList()
    }

    /* ---------- 写前检查 ---------- */
    fun writerPrompt(bookDir: File, chapter: Int): JSONObject {
        val r = run(script("story-long-write", "build_writer_prompt.py"),
            listOf("--project", bookDir.absolutePath, "--chapter", chapter.toString()), bookDir)
        val text = out(r)
        return JSONObject().put("code", code(r)).put("text", text)
            .put("ok", code(r) == 0 && !text.contains("组装中止"))
    }

    fun chapterCheck(bookDir: File, chapter: Int): String {
        val r = run(script("story-long-write", "storyctl.py"),
            listOf("chapter", "check", "--project", bookDir.absolutePath, "--chapter", chapter.toString(), "--plain"), bookDir)
        return out(r).trim()
    }

    fun trackingDraft(bookDir: File, chapter: Int): JSONObject? {
        val r = run(script("story-long-write", "tracking_commit.py"),
            listOf("draft", "--project", bookDir.absolutePath, "--chapter", chapter.toString()), bookDir)
        if (code(r) != 0) return null
        return try { JSONObject(out(r)) } catch (e: Exception) { null }
    }

    fun trackingCommit(bookDir: File, input: File): String {
        val r = run(script("story-long-write", "tracking_commit.py"),
            listOf("commit", "--project", bookDir.absolutePath, "--input", input.absolutePath), bookDir)
        return out(r).trim()
    }
}
