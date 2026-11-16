import Foundation

enum Dates {
    static func calendar(_ tz: TimeZone) -> Calendar { var c = Calendar.current; c.timeZone = tz; return c }

    static func relative(_ date: Date, tz: TimeZone, now: Date = .now) -> String {
        let cal = calendar(tz)
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: date)).day ?? 0
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: tz))
        switch days {
        case 0: return "Today \(time)"
        case 1: return "Tomorrow \(time)"
        case -1: return "Yesterday \(time)"
        case 2...6: return date.formatted(Date.FormatStyle(timeZone: tz).weekday(.wide)) + " \(time)"
        default: return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: tz))
        }
    }

    static func short(_ date: Date, tz: TimeZone) -> String { date.formatted(Date.FormatStyle(timeZone: tz).day().month(.abbreviated)) }
    static func long(_ date: Date, tz: TimeZone) -> String { date.formatted(Date.FormatStyle(date: .complete, time: .omitted, timeZone: tz)) }

    static func greeting(_ now: Date, tz: TimeZone) -> String {
        switch calendar(tz).component(.hour, from: now) {
        case 5...11: return "Good morning"
        case 12...16: return "Good afternoon"
        default: return "Good evening"
        }
    }

    static func qty(_ q: Double) -> String {
        let d = Decimal(string: String(format: "%.3f", q)) ?? Decimal(q)
        return NSDecimalNumber(decimal: d).stringValue
    }
}
