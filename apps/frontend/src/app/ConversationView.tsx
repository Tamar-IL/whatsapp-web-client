/**
 * Phase 3 tickets 3.7-3.8 — conversation view.
 *
 * Skeleton: friendly empty state when no conversation is selected.
 * Real bubble rendering, status ticks, infinite scroll, and the input bar
 * are implemented in Phase 3.
 */
export function ConversationView() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-ink-muted">
      <div className="max-w-md p-8">
        <h2 className="mb-2 text-lg font-medium text-ink">Select a conversation</h2>
        <p className="text-sm">
          Pick a chat from the list on the left to see messages. New incoming messages will
          appear here in real time.
        </p>
      </div>
    </div>
  );
}
