/**
 * Has this plugin's fault on a device survived a second report from that plugin?
 * Plugins share one device row at different intervals, so the row's combined
 * status can't answer this: netscan's next report, 60s on and healthy, would
 * count as the second sighting of one failed Synology pass.
 */
export const deviceFaultHeld = (previous: string | null | undefined, current: string): boolean =>
    current !== "online" && !!previous && previous !== "online"
