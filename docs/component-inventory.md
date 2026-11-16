# Component inventory

| design.md component | Android (`ui/components`) | iOS (`Design/`, `Features/Shared.swift`) |
|---|---|---|
| HomeHubScaffold / Navigation | `HomeHubRoot.MainShell`, `GlassNavigationBar` (<840dp), `GlassRail` (≥840dp) | `MainTabs` (system Liquid Glass `TabView`, `.sidebarAdaptable` on iPad) |
| HomeHubTopBar | `screens/Common.HomeHubTopBar` | system navigation bar + `scrollEdgeEffectStyle(.soft)` |
| GlassSurface / Toolbar / FAB | `Glass.kt` `glass()`, `GlassSurface`, `GlassToolbar`, `GlassFloatingActionButton` | `Glass.swift` `glassSurface()` (AI composer, undo bar); system toolbar buttons |
| AdaptiveBottomSheet | `FormSheet` (solid — forms are never glass) | `.sheet` + `NavigationStack` |
| HomeHubButton / IconButton | `HomeHubButton` (primary/secondary/tertiary/destructive, loading, disabled), `HomeHubIconButton` (48dp) | `HHButton` + `HHButtonStyle` (≥48pt) |
| TextField / SearchField | `HomeHubTextField` (persistent label, helper, inline error), `HomeHubSearchField` | `HHTextField`, `.searchable` |
| Card / ListTile / grouped list | `HomeHubCard`, `HomeHubListTile`, `GroupedList` | `HHCard`, `HHListRow`, `GroupedList` |
| StatusBadge / PriorityIndicator / Progress | `StatusBadge`, `PriorityIndicator`, `ProgressRow` | same names |
| Empty / Error / Skeleton | `EmptyState`, `ErrorState`, `LoadingSkeleton` (static under reduce motion) | `EmptyStateView`, `ErrorStateView`, `LoadingSkeleton` |
| ApprovalCard | `ApprovalCard` | `ApprovalCardView` |
| AgentStatusIndicator / ActivityTimeline | `AgentStatusIndicator`, `AgentActivityTimeline` | `AgentStatusView`, `ActivityTimeline` |
| TaskRow / BillRow / GroceryItemRow / BudgetSummary | domain components | `TaskRowView`, `BillRowView`, Shopping row, `BudgetSummaryView` |
| MemberAvatar | `MemberAvatar` | `MemberAvatar` |
| ConfirmationDialog / Snackbar | `ConfirmationDialog`, Snackbar host (undo on task completion) | `.confirmationDialog`, glass undo bar |
