package com.e404.homehub.spend

import android.content.Context
import android.net.Uri
import com.e404.homehub.data.remote.GatewayClient
import com.e404.homehub.data.repo.arr
import com.e404.homehub.data.repo.objects
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.text.PDFTextStripper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** The statement is protected and needs a password (or the one given was wrong). */
class StatementPasswordRequired(val wrong: Boolean) : Exception()

/** The file isn't a readable PDF, or is too large to open on a phone. */
class StatementUnreadable(message: String) : Exception(message)

/**
 * Reads a statement PDF entirely on this phone. The file is opened from the document the person picked, its text is
 * extracted in memory, and nothing — not the file, not the text — is sent anywhere. Only the payment rows the person
 * then chooses to import go to HomeHub.
 */
object StatementReader {
    private const val MAX_BYTES = 30L * 1024 * 1024
    private const val MAX_PAGES = 400

    suspend fun lines(context: Context, uri: Uri, password: String?): List<String> = withContext(Dispatchers.IO) {
        PDFBoxResourceLoader.init(context.applicationContext)
        val size = runCatching { context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull() ?: -1L
        if (size > MAX_BYTES) throw StatementUnreadable("That file is larger than 30 MB. Download a shorter date range from the app.")
        val stream = context.contentResolver.openInputStream(uri) ?: throw StatementUnreadable("Couldn't open that file.")
        try {
            stream.use { input ->
                PDDocument.load(input, password ?: "").use { doc ->
                    if (doc.numberOfPages > MAX_PAGES) throw StatementUnreadable("That statement has ${doc.numberOfPages} pages. Download a shorter date range from the app.")
                    val text = PDFTextStripper().apply { sortByPosition = true }.getText(doc)
                    text.lines()
                }
            }
        } catch (e: InvalidPasswordException) {
            throw StatementPasswordRequired(wrong = !password.isNullOrEmpty())
        } catch (e: StatementUnreadable) {
            throw e
        } catch (e: Exception) {
            throw StatementUnreadable("This doesn't look like a readable PDF statement.")
        }
    }
}

/** Server side of the import: previews against what HomeHub already has, then files the chosen rows in "To review". */
class StatementImportApi(private val gateway: GatewayClient) {
    data class Verdict(val status: String, val existingStatus: String?, val suggestedCategory: String?)
    data class Outcome(val verdicts: List<Verdict>, val imported: Int)

    companion object { const val CHUNK = 150 }

    suspend fun run(hid: String, app: StatementApp, rows: List<StatementRow>, dryRun: Boolean): Outcome {
        val verdicts = mutableListOf<Verdict>(); var imported = 0
        for (chunk in rows.chunked(CHUNK)) {
            val body = buildJsonObject {
                put("sourceApp", app.wire); put("dryRun", dryRun)
                put("rows", buildJsonArray {
                    chunk.forEach { r ->
                        add(buildJsonObject {
                            put("occurredAt", r.occurredAt); put("timeKnown", r.timeKnown); put("amountMinor", r.amountMinor)
                            put("direction", r.direction); put("method", r.method)
                            r.merchant?.let { put("merchant", it) }; r.upiRef?.let { put("upiRef", it) }; r.accountLast4?.let { put("accountLast4", it) }
                        })
                    }
                })
            }
            val res = gateway.call("POST", "/v1/households/$hid/spend/imports", body)?.jsonObject ?: JsonObject(emptyMap())
            res.arr("results").objects().forEach { o ->
                verdicts += Verdict(
                    (o["status"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "new",
                    (o["existingStatus"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
                    (o["suggestedCategory"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
                )
            }
            imported += ((res["summary"] as? JsonObject)?.get("imported") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
        }
        return Outcome(verdicts, imported)
    }
}
