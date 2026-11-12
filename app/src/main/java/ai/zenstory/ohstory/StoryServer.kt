package ai.zenstory.ohstory

import android.content.Context
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
 * 本地服务：把桌面版的 Node 服务换成 Kotlin 实现，接口形状保持一致，
 * 前端（assets/www）原样复用。
 */
class StoryServer(context: Context, private val webRoot: String = "www") :
    NanoHTTPD("127.0.0.1", 43113) {

    private val appCtx = context.applicationContext
    private val root = File(appCtx.filesDir, "projects").apply { mkdirs() }
    private val configFile = File(appCtx.filesDir, "config.json")
    private val pool = Executors.newFixedThreadPool(4)
    init {
        runCatching { Engine.ensure(appCtx) }
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(600, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /* ---------------- 配置 ---------------- */
    private fun readConfig(): JSONObject = try {
        JSONObject(configFile.readText())
    } catch (e: Exception) {
        JSONObject().put("baseURL", "").put("apiKey", "").put("model", "")
            .put("temperature", 0.85).put("maxTokens", 8000).put("thinking", false)
    }

    private fun writeConfig(patch: JSONObject): JSONObject {
        val cur = readConfig()
        val keys = patch.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            if (k == "apiKey" && patch.optString(k).startsWith("••••")) continue
            cur.put(k, patch.get(k))
        }
        configFile.writeText(cur.toString(2))
        return cur
    }

    /* ---------------- 工具 ---------------- */
    private fun json(code: Response.Status, body: String): Response =
        newFixedLengthResponse(code, "application/json; charset=utf-8", body)

    private fun err(code: Response.Status, msg: String) = json(code, JSONObject().put("error", msg).toString())

    private fun body(session: IHTTPSession): JSONObject {
        val map = HashMap<String, String>()
        session.parseBody(map)
        val raw = map["postData"] ?: map.values.firstOrNull() ?: ""
        return try { if (raw.isBlank()) JSONObject() else JSONObject(raw) } catch (e: Exception) { JSONObject() }
    }

    private fun safeBook(name: String): String {
        val n = name.trim()
        if (n.isEmpty() || n.contains("/") || n.contains("\\") || n.startsWith(".")) throw IllegalArgumentException("书名不合法")
        return n
    }

    private fun bookDir(name: String) = File(root, safeBook(name))

    private fun chapterFiles(dir: File): List<File> {
        val d = File(dir, "正文")
        if (!d.isDirectory) return emptyList()
        return d.listFiles { f -> f.isFile && (f.name.endsWith(".md") || f.name.endsWith(".txt")) }
            ?.sortedBy { it.name } ?: emptyList()
    }

    private fun countWords(s: String) = s.filter { !it.isWhitespace() }.length

    private fun bookInfo(name: String): JSONObject {
        val dir = bookDir(name)
        val files = chapterFiles(dir)
        var words = 0
        files.forEach { runCatching { words += countWords(it.readText()) } }
        return JSONObject()
            .put("name", name).put("chapters", files.size)
            .put("words", words).put("updated", dir.lastModified())
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "json", "webmanifest" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        else -> "application/octet-stream"
    }

    private fun assetsText(path: String): String? = runCatching {
        appCtx.assets.open("$webRoot/$path").bufferedReader().use { it.readText() }
    }.getOrNull()

    /* ---------------- 路由 ---------------- */
    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        return try {
            when {
                uri.startsWith("/api/") -> api(session, uri)
                else -> staticAsset(uri)
            }
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, e.message ?: "服务器错误")
        }
    }

    private fun staticAsset(uri: String): Response {
        val path = if (uri == "/" || uri.isEmpty()) "index.html" else uri.trimStart('/')
        val stream = runCatching { appCtx.assets.open("$webRoot/$path") }.getOrNull()
            ?: return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found")
        return newChunkedResponse(Response.Status.OK, mimeOf(path), stream)
    }

    private fun api(session: IHTTPSession, uri: String): Response {
        val method = session.method
        val params = session.parameters

        when {
            uri == "/api/capabilities" -> return json(Response.Status.OK,
                JSONObject().put("engine", true).put("bench", false)
                    .put("python", runCatching { Engine.script("story-long-write", "storyctl.py").isFile }.getOrDefault(false))
                    .put("platform", "android").toString())

            uri == "/api/config" && method == Method.GET -> {
                val c = readConfig()
                val key = c.optString("apiKey")
                return json(Response.Status.OK, JSONObject(c.toString())
                    .put("apiKey", if (key.isEmpty()) "" else "••••" + key.takeLast(4))
                    .put("hasKey", key.isNotEmpty()).toString())
            }
            uri == "/api/config" && method == Method.PUT -> {
                val next = writeConfig(body(session))
                return json(Response.Status.OK, JSONObject()
                    .put("ok", true).put("model", next.optString("model"))
                    .put("baseURL", next.optString("baseURL"))
                    .put("hasKey", next.optString("apiKey").isNotEmpty()).toString())
            }
            uri == "/api/models" -> {
                val cfg = readConfig()
                val url = cfg.optString("baseURL").trimEnd('/') + "/models"
                val req = Request.Builder().url(url)
                    .addHeader("Authorization", "Bearer " + cfg.optString("apiKey")).build()
                return try {
                    http.newCall(req).execute().use { r ->
                        val text = r.body?.string() ?: ""
                        val arr = JSONArray()
                        runCatching {
                            JSONObject(text).optJSONArray("data")?.let { data ->
                                for (i in 0 until data.length()) arr.put(data.getJSONObject(i).optString("id"))
                            }
                        }
                        json(Response.Status.OK, JSONObject().put("models", arr).toString())
                    }
                } catch (e: Exception) {
                    err(Response.Status.INTERNAL_ERROR, e.message ?: "拉取失败")
                }
            }
            uri == "/api/test" && method == Method.POST -> {
                val cfg = readConfig()
                val payload = JSONObject()
                    .put("model", cfg.optString("model"))
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "只回复两个字：连通")))
                    .put("max_tokens", 200)
                    .put("thinking", JSONObject().put("type", "disabled"))
                return try {
                    val req = Request.Builder().url(cfg.optString("baseURL").trimEnd('/') + "/chat/completions")
                        .addHeader("Authorization", "Bearer " + cfg.optString("apiKey"))
                        .post(payload.toString().toRequestBody("application/json".toMediaType()))
                        .build()
                    http.newCall(req).execute().use { r ->
                        val text = r.body?.string() ?: ""
                        val content = runCatching {
                            JSONObject(text).getJSONArray("choices").getJSONObject(0)
                                .getJSONObject("message").optString("content")
                        }.getOrDefault("")
                        if (!r.isSuccessful) err(Response.Status.INTERNAL_ERROR, text.take(200))
                        else json(Response.Status.OK, JSONObject().put("ok", true).put("reply", content).toString())
                    }
                } catch (e: Exception) {
                    err(Response.Status.INTERNAL_ERROR, e.message ?: "连接失败")
                }
            }

            uri == "/api/books" && method == Method.GET -> {
                val arr = JSONArray()
                root.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }
                    ?.map { bookInfo(it.name) }?.sortedByDescending { it.optLong("updated") }
                    ?.forEach { arr.put(it) }
                return json(Response.Status.OK, JSONObject().put("books", arr).toString())
            }
            uri == "/api/books" && method == Method.POST -> {
                val b = body(session)
                val name = safeBook(b.optString("name"))
                val dir = bookDir(name)
                if (dir.exists()) return err(Response.Status.CONFLICT, "这本书已经存在")
                if (b.optBoolean("short")) {
                    dir.mkdirs()
                    File(dir, "设定.md").writeText("# 设定\n\n- 目标情绪：\n- 平台：\n- 字数：\n- 人称：\n- 故事核：\n- 反转/兑现：\n")
                    File(dir, "小节大纲.md").writeText("# 小节大纲\n")
                    File(dir, "正文.md").writeText("")
                } else {
                    SKELETON.forEach { (rel, content) ->
                        val f = File(dir, rel)
                        f.parentFile?.mkdirs()
                        f.writeText(content)
                    }
                    File(dir, "正文").mkdirs()
                }
                return json(Response.Status.OK, JSONObject().put("ok", true).put("book", bookInfo(name)).toString())
            }
            uri.startsWith("/api/books/") && method == Method.DELETE -> {
                val name = safeBook(uri.removePrefix("/api/books/").let { java.net.URLDecoder.decode(it, "UTF-8") })
                bookDir(name).deleteRecursively()
                return json(Response.Status.OK, JSONObject().put("ok", true).toString())
            }

            uri == "/api/tree" -> {
                val name = safeBook(params["book"]?.firstOrNull() ?: "")
                val dir = bookDir(name)
                if (!dir.isDirectory) return err(Response.Status.NOT_FOUND, "书不存在")
                val tree = JSONArray()
                dir.listFiles { f -> !f.name.startsWith(".") }
                    ?.sortedBy { it.name }
                    ?.forEach { tree.put(node(it)) }
                val chapters = JSONArray()
                chapterFiles(dir).forEach { chapters.put(it.name) }
                return json(Response.Status.OK, JSONObject().put("tree", tree).put("chapters", chapters).toString())
            }

            uri == "/api/file" && method == Method.GET -> {
                val rel = params["path"]?.firstOrNull() ?: ""
                val f = File(root, rel)
                if (!f.isFile) return err(Response.Status.NOT_FOUND, "文件不存在")
                return json(Response.Status.OK, JSONObject().put("content", f.readText()).toString())
            }
            uri == "/api/file" && method == Method.PUT -> {
                val b = body(session)
                val f = File(root, b.optString("path"))
                if (!f.absolutePath.startsWith(root.absolutePath)) return err(Response.Status.BAD_REQUEST, "路径越界")
                f.parentFile?.mkdirs()
                val content = b.optString("content")
                f.writeText(content)
                return json(Response.Status.OK, JSONObject().put("ok", true).put("words", countWords(content)).toString())
            }
            uri == "/api/file" && method == Method.DELETE -> {
                val rel = params["path"]?.firstOrNull() ?: ""
                val f = File(root, rel)
                if (f.absolutePath.startsWith(root.absolutePath)) f.delete()
                return json(Response.Status.OK, JSONObject().put("ok", true).toString())
            }
            uri == "/api/file/rename" && method == Method.POST -> {
                val b = body(session)
                val from = File(root, b.optString("from"))
                val to = File(root, b.optString("to"))
                to.parentFile?.mkdirs()
                if (from.isFile && to.absolutePath.startsWith(root.absolutePath)) from.renameTo(to)
                return json(Response.Status.OK, JSONObject().put("ok", true).toString())
            }
            uri == "/api/chapter/new" && method == Method.POST -> {
                val b = body(session)
                val dir = bookDir(b.optString("book"))
                val files = chapterFiles(dir)
                var max = 0
                files.forEach {
                    Regex("第\\s*0*(\\d+)\\s*章").find(it.name)?.let { m -> max = maxOf(max, m.groupValues[1].toIntOrNull() ?: 0) }
                }
                val name = "第" + (max + 1).toString().padStart(3, '0') + "章_未命名.md"
                File(dir, "正文").mkdirs()
                File(File(dir, "正文"), name).writeText("")
                return json(Response.Status.OK, JSONObject().put("ok", true).put("path", "正文/$name").toString())
            }
            uri == "/api/import" && method == Method.POST -> {
                val b = body(session)
                val name = safeBook(b.optString("name"))
                val dir = File(bookDir(name), "正文")
                dir.mkdirs()
                val chapters = splitChapters(b.optString("text"))
                chapters.forEachIndexed { i, ch ->
                    val safe = ch.first.replace(Regex("[\\\\/:*?\"<>|\\n\\r]"), " ").trim().take(60)
                    File(dir, (i + 1).toString().padStart(3, '0') + "_" + safe + ".md")
                        .writeText("# ${ch.first}\n\n${ch.second}\n")
                }
                return json(Response.Status.OK, JSONObject().put("ok", true)
                    .put("count", chapters.size).put("book", bookInfo(name)).toString())
            }
            uri == "/api/export" -> {
                val name = safeBook(params["book"]?.firstOrNull() ?: "")
                val sb = StringBuilder("$name\n\n")
                chapterFiles(bookDir(name)).forEach { f ->
                    sb.append(f.readText().replace(Regex("^#\\s+"), "").trim()).append("\n\n\n")
                }
                return newFixedLengthResponse(Response.Status.OK, "text/plain; charset=utf-8", sb.toString())
            }

            uri == "/api/check" && method == Method.POST ->
                json(Response.Status.OK, JSONObject().put("findings", JSONArray())
                    .put("errors", JSONArray().put("Android 版暂未接入原版检测器")).toString())

            uri == "/api/engine/status" -> {
                val name = safeBook(params["book"]?.firstOrNull() ?: "")
                val dir = bookDir(name)
                if (!dir.isDirectory) return err(Response.Status.NOT_FOUND, "书不存在")
                return json(Response.Status.OK, Engine.status(dir).toString())
            }
            uri == "/api/engine/run" && method == Method.POST -> engineRun(body(session))
            uri == "/api/ai" && method == Method.POST -> ai(body(session))

            else -> err(Response.Status.NOT_FOUND, "Not Found")
        }
        error("unreachable")
    }


    /* ---------------- 原版引擎 ---------------- */
    private fun chatOnce(cfg: JSONObject, messages: JSONArray, maxTokens: Int = 8000): String {
        val payload = JSONObject()
            .put("model", cfg.optString("model"))
            .put("messages", messages)
            .put("temperature", cfg.optDouble("temperature", 0.85))
            .put("max_tokens", maxTokens)
            .put("thinking", JSONObject().put("type", "disabled"))
        val req = Request.Builder()
            .url(cfg.optString("baseURL").trimEnd('/') + "/chat/completions")
            .addHeader("Authorization", "Bearer " + cfg.optString("apiKey"))
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IllegalStateException(text.take(200))
            return JSONObject(text).getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").optString("content")
        }
    }

    private fun sseChat(cfg: JSONObject, messages: JSONArray, maxTokens: Int, out: PipedOutputStream): String {
        val payload = JSONObject()
            .put("model", cfg.optString("model"))
            .put("messages", messages)
            .put("temperature", cfg.optDouble("temperature", 0.85))
            .put("max_tokens", maxTokens)
            .put("stream", true)
            .put("thinking", JSONObject().put("type", "disabled"))
        val req = Request.Builder()
            .url(cfg.optString("baseURL").trimEnd('/') + "/chat/completions")
            .addHeader("Authorization", "Bearer " + cfg.optString("apiKey"))
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .build()
        val sb = StringBuilder()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
            val source = resp.body!!.source()
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (!line.startsWith("data:")) continue
                val data = line.removePrefix("data:").trim()
                if (data.isEmpty() || data == "[DONE]") continue
                val obj = runCatching { JSONObject(data) }.getOrNull() ?: continue
                val delta = obj.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta") ?: continue
                val piece = delta.optString("content")
                if (piece.isNotEmpty()) {
                    sb.append(piece)
                    out.write(("data: " + JSONObject().put("d", piece).toString() + "\n\n").toByteArray())
                }
            }
        }
        return sb.toString()
    }

    private fun engineRun(req: JSONObject): Response {
        val cfg = readConfig()
        if (cfg.optString("apiKey").isBlank() || cfg.optString("model").isBlank())
            return err(Response.Status.BAD_REQUEST, "还没配置模型")
        val bookName = req.optString("book")
        val dir = bookDir(bookName)
        val step = req.optString("step")
        val chapter = req.optInt("chapter", 0)
        val instruction = req.optString("instruction")

        if (step != "write" && step != "commit")
            return err(Response.Status.NOT_IMPLEMENTED, "安卓版暂只支持写正文与提交追踪：$step")

        val pipeIn = PipedInputStream(64 * 1024)
        val pipeOut = PipedOutputStream(pipeIn)
        val send: (JSONObject) -> Unit = { o -> runCatching { pipeOut.write(("data: $o\n\n").toByteArray()); pipeOut.flush() } }

        pool.execute {
            try {
                if (step == "write") {
                    send(JSONObject().put("phase", "brief").put("label", "读第 $chapter 章细纲与追踪"))
                    val prompt = Engine.writerPrompt(dir, chapter)
                    if (!prompt.optBoolean("ok")) throw IllegalStateException(prompt.optString("text").take(300))
                    val full = prompt.optString("text")
                    val skeleton = full.substringBefore("====")

                    val materials = buildString {
                        append("【细纲】\n").append(readIf(File(dir, "大纲/细纲_第" + chapter.toString().padStart(3, '0') + "章.md")))
                        append("\n\n【续写状态卡】\n").append(readIf(File(dir, "追踪/上下文.md")))
                        append("\n\n【卷纲】\n").append(readIf(File(dir, "大纲/卷纲_第一卷.md"), 6000))
                        append("\n\n【题材定位】\n").append(readIf(File(dir, "设定/题材定位.md"), 2500))
                        if (instruction.isNotBlank()) append("\n\n【作者本轮要求】\n").append(instruction)
                    }

                    send(JSONObject().put("phase", "filling").put("label", "主会话填槽"))
                    val filled = chatOnce(cfg, JSONArray()
                        .put(JSONObject().put("role", "system").put("content", PLANNER_SYS))
                        .put(JSONObject().put("role", "user").put("content", skeleton + "\n\n======= 项目材料 =======\n\n" + materials)), 9000)

                    send(JSONObject().put("phase", "writing").put("label", "写手开始写正文"))
                    val raw = sseChat(cfg, JSONArray()
                        .put(JSONObject().put("role", "system").put("content", WRITER_SYS))
                        .put(JSONObject().put("role", "user").put("content", filled)), 12000, pipeOut)
                    val bodyText = cleanProse(raw)

                    val outline = File(dir, "大纲/细纲_第" + chapter.toString().padStart(3, '0') + "章.md")
                    val title = Regex("###\\s*第\\s*\\d+\\s*章\\s*[：:]\\s*(.+)").find(
                        if (outline.isFile) outline.readText() else "")?.groupValues?.get(1)?.trim() ?: "未命名"
                    val fileName = "第" + chapter.toString().padStart(3, '0') + "章_" + title.replace(Regex("[\\\\/:*?\"<>|\\n\\r]"), " ") + ".md"
                    File(dir, "正文").mkdirs()
                    File(dir, "正文/$fileName").writeText("# 第${chapter}章 ${title}\n\n${bodyText.trim()}\n")

                    send(JSONObject().put("phase", "checking").put("label", "原版章节检查"))
                    val check = Engine.chapterCheck(dir, chapter)
                    send(JSONObject().put("ok", !check.contains("必须改")).put("file", fileName)
                        .put("check", JSONObject().put("text", check)).put("done", true))
                } else {
                    send(JSONObject().put("phase", "draft").put("label", "生成追踪事务草稿"))
                    val draftInfo = Engine.trackingDraft(dir, chapter)
                        ?: throw IllegalStateException("追踪草稿失败：先提交前几章，或检查 _tracking-state.json")
                    val draftPath = File(dir, draftInfo.optString("draft"))
                    val draftText = draftPath.readText()
                    send(JSONObject().put("phase", "filling").put("label", "归纳本章变化"))
                    val filled = chatOnce(cfg, JSONArray()
                        .put(JSONObject().put("role", "system").put("content", TRACKING_SYS))
                        .put(JSONObject().put("role", "user").put("content",
                            "填写说明：${draftInfo.optString("fill")}\n\nJSON：\n$draftText")), 6000)
                    val json = filled.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
                    val obj = JSONObject(json)
                    val pos = obj.optJSONObject("context")?.optJSONObject("position")
                    if (pos != null) {
                        if (pos.optString("story_time").isBlank()) pos.put("story_time", "第${chapter}章结束时")
                        if (pos.optString("scene").isBlank()) pos.put("scene", "第${chapter}章末尾场景")
                    }
                    draftPath.writeText(obj.toString(1))
                    send(JSONObject().put("phase", "commit").put("label", "提交追踪状态"))
                    val commitOut = Engine.trackingCommit(dir, draftPath)
                    send(JSONObject().put("ok", true).put("commit", commitOut).put("done", true))
                }
            } catch (e: Exception) {
                send(JSONObject().put("error", e.message ?: "执行失败"))
                send(JSONObject().put("done", true))
            } finally {
                runCatching { pipeOut.close() }
            }
        }

        return newChunkedResponse(Response.Status.OK, "text/event-stream", pipeIn)
    }

    private fun cleanProse(text: String): String {
        val lines = text.split("\n")
        val bad = Regex("`|正文如下|写入|已读|命中|→|参考文件|任务包|细纲|读取|判定|核对报告|交付")
        for (i in 0 until minOf(lines.size, 80)) {
            val t = lines[i].trim()
            if (t.length >= 12 && !bad.containsMatchIn(t) && t[0] !in "#-*（(") {
                return lines.drop(i).joinToString("\n").trim()
            }
        }
        return text.trim()
    }

    private fun node(f: File): JSONObject {
        if (f.isDirectory) {
            val children = JSONArray()
            f.listFiles { c -> !c.name.startsWith(".") }?.sortedBy { it.name }?.forEach { children.put(node(it)) }
            return JSONObject().put("type", "dir").put("name", f.name).put("path", f.name).put("children", children)
        }
        return JSONObject().put("type", "file").put("name", f.name)
            .put("path", f.name).put("size", f.length())
            .put("words", if (f.name.endsWith(".md") || f.name.endsWith(".txt")) countWords(f.readText()) else 0)
    }

    /* ---------------- AI ---------------- */
    private fun ai(req: JSONObject): Response {
        val cfg = readConfig()
        if (cfg.optString("baseURL").isBlank() || cfg.optString("apiKey").isBlank() || cfg.optString("model").isBlank())
            return err(Response.Status.BAD_REQUEST, "还没配置模型：请到「设置」填写接口、Key 并选择模型")

        val payload = JSONObject().apply {
            put("model", cfg.optString("model"))
            put("messages", buildMessages(req))
            put("temperature", cfg.optDouble("temperature", 0.85))
            put("max_tokens", cfg.optInt("maxTokens", 8000))
            put("stream", true)
            if (!cfg.optBoolean("thinking", true)) put("thinking", JSONObject().put("type", "disabled"))
        }

        val pipeIn = PipedInputStream(64 * 1024)
        val pipeOut = PipedOutputStream(pipeIn)

        pool.execute {
            try {
                val request = Request.Builder()
                    .url(cfg.optString("baseURL").trimEnd('/') + "/chat/completions")
                    .addHeader("Authorization", "Bearer " + cfg.optString("apiKey"))
                    .post(payload.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        val t = resp.body?.string() ?: ""
                        pipeOut.write("data: {\"error\":\"HTTP ${resp.code} ${t.take(120).replace("\"", "'")}\"}\n\n".toByteArray())
                    } else {
                        val source = resp.body!!.source()
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            if (!line.startsWith("data:")) continue
                            val data = line.removePrefix("data:").trim()
                            if (data.isEmpty() || data == "[DONE]") continue
                            val obj = runCatching { JSONObject(data) }.getOrNull() ?: continue
                            val delta = obj.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta") ?: continue
                            val content = delta.optString("content")
                            if (content.isNotEmpty()) {
                                val out = JSONObject().put("d", content).toString()
                                pipeOut.write("data: $out\n\n".toByteArray())
                            }
                        }
                    }
                }
                pipeOut.write("data: {\"done\":true}\n\n".toByteArray())
                pipeOut.flush()
            } catch (e: Exception) {
                runCatching {
                    pipeOut.write("data: {\"error\":\"${(e.message ?: "请求失败").replace("\"", "'")}\"}\n\n".toByteArray())
                    pipeOut.write("data: {\"done\":true}\n\n".toByteArray())
                }
            } finally {
                runCatching { pipeOut.close() }
            }
        }

        return newChunkedResponse(Response.Status.OK, "text/event-stream", pipeIn)
    }

    /* ---------------- 提示词（与桌面版一致） ---------------- */
    private fun readIf(f: File, cap: Int = 6000): String =
        if (f.isFile) f.readText().let { if (it.length > cap) it.take(cap) + "\n…（截断）" else it } else ""

    private fun bookContext(book: String): String {
        val dir = bookDir(book)
        val parts = mutableListOf<String>()
        listOf("设定/题材定位.md", "设定/人物.md", "设定/文风.md", "设定/角色/主角.md").forEach { rel ->
            val t = readIf(File(dir, rel), 2500)
            if (t.isNotBlank()) parts.add("【$rel】\n$t")
        }
        val outline = readIf(File(dir, "大纲/卷纲.md"), 3000)
        val outline2 = if (outline.isBlank()) readIf(File(dir, "大纲/卷纲_第一卷.md"), 3000) else outline
        if (outline2.isNotBlank()) parts.add("【大纲/卷纲.md】\n$outline2")
        val detail = readIf(File(dir, "大纲/细纲.md"), 4000)
        if (detail.isNotBlank()) parts.add("【大纲/细纲.md】\n$detail")
        val track = readIf(File(dir, "追踪/上下文.md"), 2500)
        if (track.isNotBlank()) parts.add("【追踪/上下文.md】\n$track")

        val files = chapterFiles(dir)
        if (files.isNotEmpty()) {
            val prev = files.last()
            val txt = readIf(prev, 5000)
            if (txt.isNotBlank()) parts.add("【上一章《${prev.name}》全文】\n$txt")
            if (files.size > 1) {
                val p2 = readIf(files[files.size - 2], 5000)
                if (p2.isNotBlank()) parts.add("【再上一章《${files[files.size - 2].name}》结尾】\n${p2.takeLast(1500)}")
            }
        }
        return parts.joinToString("\n\n")
    }

    private fun buildMessages(req: JSONObject): JSONArray {
        val mode = req.optString("mode")
        val book = req.optString("book")
        val ctx = bookContext(book)
        val instruction = req.optString("instruction")
        val selection = req.optString("selection")
        val existing = req.optString("existing")
        val chapter = req.optString("chapter")

        val sys = "你是一位资深中文网络小说写手兼编辑，熟悉起点、番茄、晋江等平台的节奏与读者口味。\n$STYLE_RULES"
        val user = when (mode) {
            "outline" -> "$ctx\n\n请基于以上设定，写出可执行的细纲，覆盖接下来 5 章。每章一小节，包含：目标情绪、必发生事件、禁止发生、章尾钩子、预计字数。只输出细纲本身。"
            "chapter" -> "$ctx\n\n现在写【${chapter.ifBlank { "下一章" }}】的正文。\n" +
                (if (instruction.isNotBlank()) "作者额外要求：$instruction\n" else "") +
                "要求：1800-2500 字，严格承接上一章结尾的时间和人物状态，按细纲推进，章尾留钩子。只输出正文。"
            "continue" -> "$ctx\n\n以下是本章已写内容，请无缝续写约 800-1200 字：\n\n$existing\n\n" +
                (if (instruction.isNotBlank()) "作者要求：$instruction\n" else "") +
                "只输出续写部分，不要重复已有内容，不要加标题。"
            "deslop" -> "请把下面这段小说文字改写得更像人写的：去掉 AI 腔套话、书面语和总结式抒情，保留全部情节、人物动作和信息，句子更短更利落，字数不减少 10% 以上。只输出改写后的正文。\n\n${selection.ifBlank { existing }}"
            "review" -> "$ctx\n\n请以编辑身份审这一章稿：\n\n${existing.ifBlank { selection }}\n\n输出三部分：①节奏与情绪问题（指出具体段落）②人设/设定/伏笔冲突 ③可直接改的 5 条建议。简洁，不打分。"
            "polish" -> "请润色下面这段文字，保持原意和人物语气，提升画面感和节奏，不添加新情节。只输出润色后的正文。\n\n${selection.ifBlank { existing }}"
            else -> throw IllegalArgumentException("未知的写作模式")
        }

        return JSONArray()
            .put(JSONObject().put("role", "system").put("content", sys))
            .put(JSONObject().put("role", "user").put("content", user))
    }

    private fun splitChapters(text: String): List<Pair<String, String>> {
        val lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        val re = Regex("^(第\\s*[0-9零一二三四五六七八九十百千两]+\\s*[章节回卷]|Chapter\\s*\\d+|楔子|序章|尾声|后记)\\s*.{0,40}$")
        val heads = mutableListOf<Pair<Int, String>>()
        lines.forEachIndexed { i, line ->
            val t = line.trim().removePrefix("#").trim()
            if (t.isNotEmpty() && t.length <= 45 && re.matches(t)) heads.add(i to t)
        }
        if (heads.isEmpty()) return listOf("正文" to text.trim())
        val out = mutableListOf<Pair<String, String>>()
        heads.forEachIndexed { k, h ->
            val end = if (k + 1 < heads.size) heads[k + 1].first else lines.size
            val bodyText = lines.subList(h.first + 1, end).joinToString("\n").trim()
            if (bodyText.isNotEmpty()) out.add(h.second to bodyText)
        }
        return out
    }

    companion object {
        private val PLANNER_SYS = """你是 oh-story 写作流程里的「主会话」，职责是把写手 prompt 骨架里所有「［主会话填］」槽位填完。
只输出填好的整份 prompt，骨架里除空槽外的文字一字不改；不解释、不加代码块。槽位要具体，不写"按需""参考细纲"这类空话。"""

        private val WRITER_SYS = """你是 narrative-writer。严格按任务包执行，只输出正文：不要标题、不要解释、不要过程说明。"""

        private val TRACKING_SYS = """你是 oh-story 的追踪提交者。只输出填写后的完整 JSON，不改结构、不删字段、不加解释、不用代码块。"""

        private val STYLE_RULES = """
写作硬规则：
1. 中文网文语感，短句为主，动作和对话推进，少用书面语连接词。
2. 禁止 AI 腔：不要"不禁""仿佛""一丝""缓缓地""空气中弥漫着""这一刻，时间仿佛静止"这类套话；不要每段都用排比和破折号；不要总结式抒情收尾。
3. 不写大纲词（如"本章""爽点""伏笔回收"）进正文。
4. 人物说话要有辨识度，不用"某某说道"高频重复，用动作替代。
5. 章尾留钩子，不把情绪写满，留一个具体的悬念或未完成动作。
6. 只输出正文，不要标题、不要解释、不要 Markdown 标记。
""".trim()

        private val SKELETON = mapOf(
            "设定/题材定位.md" to "# 题材定位\n\n- 平台：\n- 赛道/题材：\n- 目标读者：\n- 核心爽点：\n- 一句话卖点：\n",
            "设定/人物.md" to "# 人物\n\n## 主角\n\n- 姓名：\n- 身份：\n- 想要：\n- 缺什么：\n",
            "设定/文风.md" to "# 文风\n\n- 叙述人称：\n- 句长偏好：\n- 禁用词/腔调：\n",
            "大纲/卷纲.md" to "# 第一卷\n\n## 本卷目标\n\n## 关键事件\n\n1. \n2. \n",
            "大纲/细纲.md" to "# 细纲\n\n<!-- 每章一节：目标情绪 / 必发生 / 禁止发生 / 章尾钩子 -->\n",
            "追踪/上下文.md" to "# 当前上下文\n\n## 当前位置\n\n- 当前章：\n- 故事时间：\n\n## 长期约束\n\n## 活跃伏笔\n\n## 下一章承诺\n"
        )
    }
}
