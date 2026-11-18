import SwiftUI
import PDFKit
import UniformTypeIdentifiers

// Import a PhonePe / Google Pay / Paytm / bank statement PDF. The PDF is read on this phone with PDFKit; only the
// payments the person ticks are sent, and they land in Finance → To review — nothing is booked until confirmed there.

enum StatementReader {
    enum Failure: Error { case password(wrong: Bool), unreadable(String) }
    private static let maxBytes = 30 * 1024 * 1024
    private static let maxPages = 400

    /// Opens the picked document, extracts its text in memory and returns it as lines. Nothing leaves the device.
    static func lines(url: URL, password: String?) throws -> [String] {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maxBytes {
            throw Failure.unreadable("That file is larger than 30 MB. Download a shorter date range from the app.")
        }
        guard let doc = PDFDocument(url: url) else { throw Failure.unreadable("This doesn't look like a readable PDF statement.") }
        if doc.isLocked {
            guard let pw = password, !pw.isEmpty else { throw Failure.password(wrong: false) }
            if !doc.unlock(withPassword: pw) { throw Failure.password(wrong: true) }
        }
        if doc.pageCount > maxPages { throw Failure.unreadable("That statement has \(doc.pageCount) pages. Download a shorter date range from the app.") }
        let text = (0..<doc.pageCount).compactMap { doc.page(at: $0)?.string }.joined(separator: "\n")
        return text.components(separatedBy: .newlines)
    }
}

/// Server side of the import: previews against what HomeHub already has, then files the chosen rows in To review.
enum StatementImportAPI {
    struct Verdict { let status: String; let existingStatus: String?; let suggestedCategory: String? }
    static let chunk = 150   // the gateway rejects request bodies over 64 KB

    static func run(hid: String, app: StatementApp, rows: [StatementRow], dryRun: Bool) async throws -> (verdicts: [Verdict], imported: Int) {
        var verdicts: [Verdict] = []; var imported = 0
        var start = 0
        while start < rows.count {
            let part = Array(rows[start..<min(start + chunk, rows.count)]); start += chunk
            let res = try await Gateway.shared.call("POST", "/v1/households/\(hid)/spend/imports",
                                                    body: ["sourceApp": app.rawValue, "dryRun": dryRun, "rows": part.map(\.json)])
            for o in res["results"] as? [[String: Any]] ?? [] {
                verdicts.append(Verdict(status: o["status"] as? String ?? "new", existingStatus: o["existingStatus"] as? String, suggestedCategory: o["suggestedCategory"] as? String))
            }
            imported += ((res["summary"] as? [String: Any])?["imported"] as? NSNumber)?.intValue ?? 0
        }
        return (verdicts, imported)
    }
}

struct StatementImportSheet: View {
    let h: HouseholdContext
    var onImported: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    private enum Stage {
        case pick
        case working(String)
        case password(URL, wrong: Bool)
        case review(StatementParse, [StatementImportAPI.Verdict], Set<Int>)
        case done(Int)
        case failed(String)
    }
    @State private var stage: Stage = .pick
    @State private var picking = false
    @State private var password = ""
    @State private var adding = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) { content }.padding(Space.lg)
            }
            .background(HH.canvas)
            .navigationTitle("Import a statement").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf]) { result in
                if case .success(let url) = result { open(url, password: nil) }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch stage {
        case .pick:
            Text("Pick a statement PDF from PhonePe, Google Pay, Paytm or your bank. It's read on this phone — the file itself is never uploaded. You'll see every payment first, and anything already in HomeHub is left out.")
                .font(HHFont.body).foregroundStyle(HH.inkSecondary)
            HHButton(title: "Choose a PDF", systemImage: "doc.badge.plus") { picking = true }
        case .working(let message):
            Text(message).font(HHFont.body).foregroundStyle(HH.inkSecondary)
            HHButton(title: "Working…", loading: true) {}.disabled(true)
        case .password(let url, let wrong):
            Text(wrong ? "That password didn't open the statement. Try again."
                       : "This statement is password-protected. Statements from banks and UPI apps are usually locked with a password they showed you when you downloaded it — often your date of birth or phone number.")
                .font(HHFont.body).foregroundStyle(wrong ? HH.danger : HH.inkSecondary)
            HHTextField(label: "PDF password", text: $password, secure: true)
            HHButton(title: "Open statement") { open(url, password: password) }.disabled(password.isEmpty)
        case .failed(let message):
            Text(message).font(HHFont.body).foregroundStyle(HH.danger)
            HHButton(title: "Choose another PDF", kind: .secondary) { stage = .pick }
        case .done(let n):
            Text(n == 0 ? "Nothing new to add." : "Added \(n) \(n == 1 ? "payment" : "payments") to To review. Confirm each one to put it in Finance.")
                .font(HHFont.body).foregroundStyle(HH.ink)
            HHButton(title: "Done") { onImported(); dismiss() }
        case .review(let parse, let verdicts, let selected):
            review(parse, verdicts, selected)
        }
    }

    @ViewBuilder private func review(_ parse: StatementParse, _ v: [StatementImportAPI.Verdict], _ selected: Set<Int>) -> some View {
        let count = { (s: String) in v.filter { $0.status == s }.count }
        let actionable = parse.rows.indices.filter { i in v.indices.contains(i) && (v[i].status == "new" || v[i].status == "possible_duplicate") }
        let already = count("already_captured") + count("duplicate_in_file")
        Text("Found \(parse.rows.count) payments in your \(parse.app.label).").font(HHFont.cardTitle).foregroundStyle(HH.ink)
        Text([
            "\(count("new")) new",
            already > 0 ? "\(already) already in HomeHub or listed twice — left out" : nil,
            count("possible_duplicate") > 0 ? "\(count("possible_duplicate")) may match something you entered by hand — not ticked" : nil,
            count("invalid") > 0 ? "\(count("invalid")) with an unusual date — left out" : nil,
            parse.skipped > 0 ? "\(parse.skipped) skipped: couldn't tell money in from money out" : nil,
        ].compactMap { $0 }.joined(separator: "\n")).font(HHFont.bodyCompact).foregroundStyle(HH.inkSecondary)
        if actionable.isEmpty {
            Text("There's nothing new to import from this statement.").font(HHFont.body).foregroundStyle(HH.ink)
            HHButton(title: "Close", kind: .secondary) { dismiss() }
        } else {
            let all = selected.count == actionable.count
            HStack {
                Text("\(selected.count) of \(actionable.count) selected").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
                Spacer()
                Button(all ? "Clear all" : "Select all") { stage = .review(parse, v, all ? [] : Set(actionable)) }.font(HHFont.label).foregroundStyle(HH.brand)
            }
            LazyVStack(spacing: 0) {
                ForEach(actionable, id: \.self) { i in
                    let r = parse.rows[i]; let dup = v[i].status == "possible_duplicate"
                    Button {
                        var s = selected; if s.contains(i) { s.remove(i) } else { s.insert(i) }
                        stage = .review(parse, v, s)
                    } label: {
                        HStack(spacing: Space.sm) {
                            Image(systemName: selected.contains(i) ? "checkmark.circle.fill" : "circle").foregroundStyle(selected.contains(i) ? HH.brand : HH.inkTertiary).imageScale(.large)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.merchant ?? (r.direction == "credit" ? "Money received" : "Payment")).font(HHFont.cardTitle).foregroundStyle(HH.ink)
                                Text(dateText(r.occurredAt)).font(HHFont.caption).foregroundStyle(HH.inkSecondary)
                                if dup { StatusBadge(label: "Possibly already recorded", tone: .warning, systemImage: "doc.on.doc") }
                            }
                            Spacer()
                            Text((r.direction == "credit" ? "+" : "") + Money.format(r.amountMinor, "INR")).font(HHFont.numeric).foregroundStyle(r.direction == "credit" ? HH.success : HH.ink)
                        }.padding(.vertical, Space.xs).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
            HHButton(title: "Add \(selected.count) to To review", loading: adding) {
                adding = true
                Task {
                    do {
                        let rows = selected.sorted().map { parse.rows[$0] }
                        let out = try await StatementImportAPI.run(hid: h.hid, app: parse.app, rows: rows, dryRun: false)
                        stage = .done(out.imported)
                    } catch { stage = .failed(error.localizedDescription + " Nothing was added twice — you can try again.") }
                    adding = false
                }
            }.disabled(selected.isEmpty)
            Text("Nothing is added to Finance yet. Each payment waits in To review until you confirm it.").font(HHFont.caption).foregroundStyle(HH.inkTertiary)
        }
    }

    private func dateText(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter().date(from: iso) else { return "" }
        let f = DateFormatter(); f.timeZone = h.tz; f.dateFormat = "d MMM yyyy"
        return f.string(from: d)
    }

    private func open(_ url: URL, password pw: String?) {
        stage = .working("Reading the statement on this phone…")
        Task {
            do {
                let parse = try await Task.detached { StatementParser.parse(try StatementReader.lines(url: url, password: pw), zone: h.tz) }.value
                if parse.rows.isEmpty {
                    stage = .failed(parse.skipped > 0
                        ? "Found \(parse.skipped) payments, but couldn't tell whether money went out or came in, so nothing was imported. Download the statement from the PhonePe, Google Pay or Paytm app instead."
                        : "Couldn't find any payments in this PDF. Use the transaction statement from PhonePe, Google Pay or Paytm, or your bank's account statement.")
                    return
                }
                stage = .working("Checking \(parse.rows.count) payments against what HomeHub already has…")
                let out = try await StatementImportAPI.run(hid: h.hid, app: parse.app, rows: parse.rows, dryRun: true)
                let fresh = Set(parse.rows.indices.filter { out.verdicts.indices.contains($0) && out.verdicts[$0].status == "new" })
                stage = .review(parse, out.verdicts, fresh)
            } catch StatementReader.Failure.password(let wrong) {
                password = ""; stage = .password(url, wrong: wrong)
            } catch StatementReader.Failure.unreadable(let m) {
                stage = .failed(m)
            } catch {
                stage = .failed(error.localizedDescription)
            }
        }
    }
}
