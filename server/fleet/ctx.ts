/** Who a push may go to, and how they relate to the system. daemonitor.com filters on each person's settings. */
export type PushRel = "own" | "manage" | "view"

/** One alert raised or cleared, for phone and browser push. */
export interface PushAlert {
  event: "raised" | "resolved"
  /** The alert's notification type: error, warning, info, success. */
  level: string
  title: string
  body: string
  /** Where tapping it goes on daemonitor.com, always under /app/. */
  path: string
  /** Same for an alert and its recovery, so the recovery replaces it on the lock screen. */
  tag: string
  recipients: { userId: string; rel: PushRel }[]
}

/** What the alerting code needs from its surroundings, in place of an h3 event. */
export interface FleetCtx {
  /**
   * Web Push. Subscriptions and the VAPID key live at daemonitor.com, so this
   * posts to its relay. A no-op until the tenant holds a relay secret.
   */
  push(alert: PushAlert): Promise<void>
}

/** An HTTP error to hand back across the DO's RPC boundary. */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}
