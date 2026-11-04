/** What the alerting code needs from its surroundings, in place of an h3 event. */
export interface FleetCtx {
  /**
   * Phone push for one user. Push credentials and device tokens live at
   * daemonitor.com, so this posts to its relay. A no-op until the relay exists.
   */
  push(userId: string, payload: { title: string; body: string; data?: Record<string, string> }): Promise<void>
}

/** An HTTP error to hand back across the DO's RPC boundary. */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}
