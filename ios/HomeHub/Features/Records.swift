import SwiftUI
import SwiftData
import FirebaseFirestore

enum FieldKind { case text, multiline, choice([(String, String)]), date, dateTime, amount, number, toggle }
struct FieldSpec: Identifiable { let key: String, label: String, kind: FieldKind; var optional = false; var id: String { key } }

struct RecordSpec {
    let title: String, collection: String, icon: String, emptyTitle: String, emptyMessage: String
    let fields: [FieldSpec]
    var query: (FirebaseFirestore.Query) -> FirebaseFirestore.Query = { $0 }
    var group: (Record) -> String = { _ in "" }
    var rowTitle: (Record) -> String = { $0.s("title") ?? $0.s("name") ?? "Untitled" }
    var subtitle: (Record) -> String? = { _ in nil }
    var badge: (Record) -> (String, Tone)? = { _ in nil }
    var defaults: [String: Any] = [:]
    var canRead = true, canWrite = true, canDelete = false

    static func memberOptions(_ h: HouseholdContext) -> [(String, String)] { [("", "Unassigned")] + h.members.map { ($0.id, $0.displayName.components(separatedBy: " ").first ?? $0.displayName) } }

    static func cleaning(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Cleaning", collection: "cleaningSchedules", icon: "bubbles.and.sparkles", emptyTitle: "No cleaning routines", emptyMessage: "Set up room-wise routines — daily wipe-downs to seasonal deep cleans.",
                   fields: [.init(key: "title", label: "Routine", kind: .text), .init(key: "roomName", label: "Room", kind: .text),
                            .init(key: "frequency", label: "How often", kind: .choice([("daily", "Daily"), ("weekly", "Weekly"), ("monthly", "Monthly"), ("seasonal", "Seasonal")])),
                            .init(key: "assigneeUid", label: "Assigned to", kind: .choice(memberOptions(h)), optional: true), .init(key: "nextDueAt", label: "Next due", kind: .date, optional: true),
                            .init(key: "deepClean", label: "Deep-cleaning plan", kind: .toggle)],
                   query: { h.role.isAdultPlus ? $0 : $0.whereField("assigneeUid", isEqualTo: h.uid) },
                   group: { ($0.s("frequency") ?? "other").capitalized },
                   subtitle: { r in [r.s("roomName"), h.name(r.s("assigneeUid")), r.t("nextDueAt").map { Dates.relative($0, tz: h.tz) }].compactMap { $0 }.joined(separator: " · ") },
                   badge: { $0.b("deepClean") ? ("Deep clean", .info) : nil },
                   defaults: ["visibleToChildren": false, "lastCompletedAt": NSNull()], canWrite: h.role.isAdultPlus, canDelete: h.role.isAdultPlus)
    }

    static func maintenance(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Maintenance", collection: "maintenanceRecords", icon: "wrench.and.screwdriver", emptyTitle: "No maintenance records", emptyMessage: "Log repairs and services. Booking a provider always needs your approval.",
                   fields: [.init(key: "title", label: "Issue or service", kind: .text), .init(key: "assetName", label: "Asset", kind: .text, optional: true),
                            .init(key: "status", label: "Status", kind: .choice([("requested", "Requested"), ("scheduled", "Scheduled"), ("in_progress", "In progress"), ("done", "Done"), ("cancelled", "Cancelled")])),
                            .init(key: "priority", label: "Priority", kind: .choice([("normal", "Normal"), ("high", "High"), ("urgent", "Urgent"), ("low", "Low")])),
                            .init(key: "nextDueAt", label: "Next due", kind: .date, optional: true), .init(key: "providerName", label: "Provider", kind: .text, optional: true),
                            .init(key: "costMinor", label: "Cost", kind: .amount, optional: true), .init(key: "description", label: "Notes", kind: .multiline, optional: true)],
                   query: { h.role.isAdultPlus ? $0 : $0.whereField("assigneeUid", isEqualTo: h.uid) },
                   group: { ["done", "cancelled"].contains($0.s("status") ?? "") ? "History" : "Open" },
                   subtitle: { r in [r.s("assetName"), r.s("providerName"), r.t("nextDueAt").map { "next \(Dates.short($0, tz: h.tz))" }, r.i("costMinor").map { Money.format($0, h.currency) }].compactMap { $0 }.joined(separator: " · ") },
                   badge: { r in switch r.s("status") { case "requested": ("Requested", .info); case "scheduled": ("Scheduled", .brand); case "in_progress": ("In progress", .warning); case "done": ("Done", .success); default: nil } },
                   defaults: ["assigneeUid": NSNull(), "underWarranty": NSNull(), "preferredDates": [String]()],
                   canRead: h.role.isAdultPlus || h.role == .staff, canWrite: h.role.isAdultPlus, canDelete: h.role.isManager)
    }

    static func inventory(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Inventory", collection: "inventoryItems", icon: "sofa", emptyTitle: "Nothing in your inventory", emptyMessage: "Track furniture, appliances, electronics and valuables with warranty dates.",
                   fields: [.init(key: "name", label: "Item", kind: .text),
                            .init(key: "category", label: "Category", kind: .choice(["Furniture", "Appliance", "Electronics", "Kitchen", "Valuables", "Other"].map { ($0, $0) })),
                            .init(key: "location", label: "Location", kind: .text, optional: true), .init(key: "quantity", label: "Quantity", kind: .number, optional: true),
                            .init(key: "purchaseDate", label: "Purchased", kind: .date, optional: true), .init(key: "warrantyExpiresAt", label: "Warranty until", kind: .date, optional: true)],
                   group: { $0.s("category") ?? "Other" },
                   subtitle: { r in [r.s("location"), r.d("quantity").map { "×\(Dates.qty($0))" }, r.t("warrantyExpiresAt").map { "warranty to \(Dates.short($0, tz: h.tz))" }].compactMap { $0 }.joined(separator: " · ") },
                   canRead: h.role.isAdultPlus, canWrite: h.role.isAdultPlus, canDelete: h.role.isManager)
    }

    static func calendar(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Calendar", collection: "events", icon: "calendar", emptyTitle: "Nothing scheduled", emptyMessage: "Add appointments, birthdays, school events and more.",
                   fields: [.init(key: "title", label: "Event", kind: .text), .init(key: "startAt", label: "Starts", kind: .dateTime), .init(key: "endAt", label: "Ends", kind: .dateTime),
                            .init(key: "category", label: "Type", kind: .choice([("appointment", "Appointment"), ("birthday", "Birthday"), ("anniversary", "Anniversary"), ("school", "School"), ("social", "Social"), ("other", "Other")])),
                            .init(key: "location", label: "Where", kind: .text, optional: true), .init(key: "staffVisible", label: "Visible to staff", kind: .toggle)],
                   query: { q in
                       let base = h.role == .child ? q.whereField("visibility", isEqualTo: "household") : (h.role == .staff ? q.whereField("staffVisible", isEqualTo: true) : q)
                       return base.whereField("startAt", isGreaterThanOrEqualTo: Timestamp(date: Dates.calendar(h.tz).startOfDay(for: .now))).order(by: "startAt").limit(to: 100)
                   },
                   group: { $0.t("startAt").map { Dates.long($0, tz: h.tz) } ?? "Undated" },
                   subtitle: { r in [r.t("startAt").map { $0.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: h.tz)) }, r.s("category")?.capitalized, r.s("location")].compactMap { $0 }.joined(separator: " · ") },
                   defaults: ["visibility": "household", "attendeeUids": [String](), "reminderMinutes": 60], canWrite: h.role.isAdultPlus || h.role == .child, canDelete: h.role.isAdultPlus)
    }

    static func documents(_ h: HouseholdContext) -> RecordSpec {
        RecordSpec(title: "Documents", collection: "documents", icon: "doc.on.doc", emptyTitle: "No documents yet", emptyMessage: "Keep agreements, insurance, warranties and receipts with expiry reminders.",
                   fields: [.init(key: "title", label: "Title", kind: .text),
                            .init(key: "category", label: "Category", kind: .choice(["Property", "Insurance", "Warranty", "Receipt", "Agreement", "Identity", "Other"].map { ($0, $0) })),
                            .init(key: "expiresAt", label: "Expires", kind: .date, optional: true), .init(key: "restricted", label: "Restricted (only people you allow, plus managers)", kind: .toggle)],
                   group: { $0.s("category") ?? "Other" },
                   subtitle: { r in [r.t("updatedAt").map { "updated \(Dates.short($0, tz: h.tz))" }, r.t("expiresAt").map { "expires \(Dates.short($0, tz: h.tz))" }].compactMap { $0 }.joined(separator: " · ") },
                   badge: { $0.b("restricted") ? ("Restricted", .warning) : nil },
                   defaults: ["allowedUids": [String](), "fileType": NSNull(), "storagePath": "households/\(h.hid)/documents/unattached"],
                   canRead: h.role.isAdultPlus, canWrite: h.role.isAdultPlus, canDelete: h.role.isManager)
    }
}

struct RecordListView: View {
    let spec: RecordSpec
    @Environment(\.household) private var hOpt
    @State private var q: LiveQuery<Record>?
    @State private var editing: Record?
    @State private var creating = false
    var body: some View {
        if let h = hOpt {
            Screen(title: spec.title) {
                if !spec.canRead { EmptyStateView(systemImage: "lock", title: "Not available for your role", message: "Ask an adult in your household if you need this.") }
                else if case .failed(let m) = q?.state ?? .loading { ErrorStateView(message: m) }
                else if case .loading = q?.state ?? .loading { LoadingSkeleton() }
                else {
                    let rows = (q?.items ?? []).filter { !$0.b("deleted") }
                    if rows.isEmpty { EmptyStateView(systemImage: spec.icon, title: spec.emptyTitle, message: spec.emptyMessage, actionTitle: spec.canWrite ? "Add" : nil) { creating = true } }
                    ForEach(Dictionary(grouping: rows, by: spec.group).sorted { $0.key < $1.key }, id: \.key) { g, items in
                        if !g.isEmpty { SectionHeader(title: g) }
                        GroupedList {
                            ForEach(Array(items.enumerated()), id: \.element.id) { i, r in
                                if i > 0 { RowDivider() }
                                Button { editing = r } label: {
                                    HHListRow(title: spec.rowTitle(r), subtitle: spec.subtitle(r).flatMap { $0.isEmpty ? nil : $0 }, systemImage: spec.icon,
                                              trailing: spec.badge(r).map { AnyView(StatusBadge(label: $0.0, tone: $0.1)) })
                                }.buttonStyle(.plain).disabled(!spec.canWrite)
                            }
                        }
                    }
                }
            }
            .toolbar { if spec.canWrite { ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add") } } }
            .task(id: spec.collection) { if spec.canRead { q = LiveQuery(spec.query(Firestore.firestore().collection("households/\(h.hid)/\(spec.collection)"))) { Record(id: $0, data: $1) } } }
            .sheet(isPresented: $creating) { RecordForm(spec: spec, h: h, record: nil) }
            .sheet(item: $editing) { RecordForm(spec: spec, h: h, record: $0) }
        }
    }
}

private struct RecordForm: View {
    let spec: RecordSpec, h: HouseholdContext, record: Record?
    @Environment(\.dismiss) private var dismiss
    @State private var text: [String: String] = [:]
    @State private var dates: [String: Date] = [:]
    @State private var enabled: [String: Bool] = [:]
    @State private var busy = false
    @State private var tried = false
    @State private var error: String?
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    ForEach(spec.fields) { f in field(f) }
                    if let error { Text(error).font(HHFont.bodyCompact).foregroundStyle(HH.danger) }
                    HHButton(title: record == nil ? "Save" : "Save changes", loading: busy, action: save)
                    if record != nil && spec.canDelete { HHButton(title: "Delete", kind: .tertiary) { confirmDelete = true } }
                }.padding(Space.lg)
            }
            .navigationTitle(record.map(spec.rowTitle) ?? "Add to \(spec.title)").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .confirmationDialog("Delete this record?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { try? await HouseholdWrites.delete(h.hid, spec.collection, id: record!.id); dismiss() } }
            } message: { Text("It will be removed for everyone in the household. This can't be undone.") }
            .onAppear(perform: load)
        }
    }

    @ViewBuilder private func field(_ f: FieldSpec) -> some View {
        let binding = Binding(get: { text[f.key] ?? "" }, set: { text[f.key] = $0 })
        switch f.kind {
        case .text: HHTextField(label: f.label, text: binding, optional: f.optional, error: tried && !f.optional && binding.wrappedValue.isEmpty ? "Required" : nil)
        case .multiline: HHTextField(label: f.label, text: binding, optional: f.optional, multiline: true)
        case .amount: HHTextField(label: "\(f.label) (\(h.currency))", text: binding, optional: f.optional, error: !binding.wrappedValue.isEmpty && Money.parse(binding.wrappedValue, currency: h.currency) == nil ? "Not a valid amount" : nil, keyboard: .decimalPad)
        case .number: HHTextField(label: f.label, text: binding, optional: f.optional, error: !binding.wrappedValue.isEmpty && Double(binding.wrappedValue) == nil ? "Enter a number" : nil, keyboard: .decimalPad)
        case .choice(let opts):
            Text(f.label).font(HHFont.label)
            ChoiceChips(options: opts, selection: Binding(get: { text[f.key] ?? opts.first?.0 ?? "" }, set: { text[f.key] = $0 }))
        case .toggle: Toggle(f.label, isOn: Binding(get: { text[f.key] == "true" }, set: { text[f.key] = $0 ? "true" : "false" })).tint(HH.brand)
        case .date, .dateTime:
            Toggle(f.label, isOn: Binding(get: { enabled[f.key] ?? !f.optional }, set: { enabled[f.key] = $0 })).tint(HH.brand)
            if enabled[f.key] ?? !f.optional {
                DatePicker(f.label, selection: Binding(get: { dates[f.key] ?? .now }, set: { dates[f.key] = $0 }), displayedComponents: Self.components(f.kind))
                    .environment(\.timeZone, h.tz).labelsHidden()
            }
        }
    }

    private static func components(_ k: FieldKind) -> DatePickerComponents { if case .dateTime = k { return [.date, .hourAndMinute] }; return [.date] }

    private func load() {
        guard let r = record else { return }
        for f in spec.fields {
            switch f.kind {
            case .date, .dateTime: if let d = r.t(f.key) { dates[f.key] = d; enabled[f.key] = true } else { enabled[f.key] = false }
            case .amount: text[f.key] = r.i(f.key).map { Money.toInput($0, h.currency) } ?? ""
            case .number: text[f.key] = r.d(f.key).map { Dates.qty($0) } ?? ""
            case .toggle: text[f.key] = r.b(f.key) ? "true" : "false"
            default: text[f.key] = r.s(f.key) ?? ""
            }
        }
    }

    private func save() {
        tried = true
        var data: [String: Any] = [:]
        for f in spec.fields {
            let v = (text[f.key] ?? "").trimmingCharacters(in: .whitespaces)
            switch f.kind {
            case .text, .multiline:
                if v.isEmpty && !f.optional { return }
                data[f.key] = v.isEmpty ? NSNull() : v
            case .choice(let opts): let val = text[f.key] ?? opts.first?.0 ?? ""; data[f.key] = val.isEmpty ? NSNull() : val
            case .toggle: data[f.key] = v == "true"
            case .amount: if v.isEmpty { data[f.key] = NSNull() } else { guard let m = Money.parse(v, currency: h.currency) else { return }; data[f.key] = m }
            case .number: if v.isEmpty { data[f.key] = NSNull() } else { guard let n = Double(v) else { return }; data[f.key] = n }
            case .date, .dateTime: data[f.key] = (enabled[f.key] ?? !f.optional) ? Timestamp(date: dates[f.key] ?? .now) : NSNull()
            }
        }
        busy = true
        Task {
            do {
                if let r = record { try await HouseholdWrites.update(h.hid, spec.collection, id: r.id, uid: h.uid, data) }
                else { try await HouseholdWrites.create(h.hid, spec.collection, uid: h.uid, spec.defaults.merging(data) { _, n in n }) }
                dismiss()
            } catch { self.error = "Couldn't save. Check your connection and permissions." }
            busy = false
        }
    }
}

// MARK: Notes (offline)

struct NotesView: View {
    @Environment(\.household) private var hOpt
    @Query(sort: \LocalNote.updatedAt, order: .reverse) private var all: [LocalNote]
    @State private var search = ""
    @State private var editing: LocalNote?
    @State private var creating = false
    var body: some View {
        if let h = hOpt {
            let notes = all.filter { $0.householdId == h.hid && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.body.localizedCaseInsensitiveContains(search)) }
            Screen(title: "Notes") {
                if notes.isEmpty { EmptyStateView(systemImage: "note.text", title: search.isEmpty ? "No notes yet" : "No matching notes", message: "Shared notes are visible to the household; private notes only to you. Notes work offline.") }
                ForEach([("household", "Shared"), ("private", "Private")], id: \.0) { vis, label in
                    let rows = notes.filter { $0.visibility == vis }
                    if !rows.isEmpty {
                        SectionHeader(title: label)
                        GroupedList {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { i, n in
                                if i > 0 { RowDivider() }
                                Button { editing = n } label: { HHListRow(title: n.title.isEmpty ? "Untitled" : n.title, subtitle: String(n.body.prefix(80)), systemImage: "note.text",
                                                                            trailing: n.pendingSync ? AnyView(Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(HH.inkTertiary)) : nil) }.buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search notes")
            .toolbar { ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New note") } }
            .sheet(isPresented: $creating) { NoteEditor(h: h, note: nil) }
            .sheet(item: $editing) { NoteEditor(h: h, note: $0) }
        }
    }
}

private struct NoteEditor: View {
    let h: HouseholdContext, note: LocalNote?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var noteBody = ""
    @State private var vis = "household"
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.md) {
                    HHTextField(label: "Title", text: $title)
                    HHTextField(label: "Note", text: $noteBody, multiline: true)
                    if note == nil { Picker("Visibility", selection: $vis) { Text("Shared with household").tag("household"); Text("Private to me").tag("private") }.pickerStyle(.segmented) }
                    HHButton(title: "Save") { model.offline.saveNote(hid: h.hid, uid: h.uid, id: note?.id, title: title.isEmpty ? "Untitled" : title, body: noteBody, visibility: vis); dismiss() }
                }.padding(Space.lg)
            }
            .navigationTitle(note == nil ? "New note" : "Edit note").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear { if let n = note { title = n.title; noteBody = n.body; vis = n.visibility } }
        }
    }
}
