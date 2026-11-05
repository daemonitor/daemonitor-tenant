// Compute cpu%/mem% series from client_state_history rows. Shared by the
// per-service (history) and batch (history-batch) endpoints.

export function memPct(data: any): number {
    const total = Number(data?.totalmem) || 0
    const avail = Number(data?.available ?? data?.freemem) || 0
    return total ? Math.round((1 - avail / total) * 100) : 0
}

export function osTimes(data: any): { idle: number; total: number } {
    const cpus = Array.isArray(data?.cpus) ? data.cpus : []
    let idle = 0, total = 0
    for (const c of cpus) {
        const t = c?.times || {}
        idle += Number(t.idle) || 0
        total += (Number(t.user) || 0) + (Number(t.nice) || 0) + (Number(t.sys) || 0) + (Number(t.idle) || 0) + (Number(t.irq) || 0)
    }
    return { idle, total }
}

export function directCpu(type: string, data: any): number {
    if (type === "pm2") return Math.round(Number(data?.monit?.cpu) || 0)
    if (type === "lxc-container") return Math.round(Number(data?.container?.cpu) || 0)
    if (type === "docker" || type === "lxc") {
        const c = Array.isArray(data?.containers) ? data.containers : []
        return Math.round(c.reduce((s: number, x: any) => s + (Number(x.cpu) || 0), 0))
    }
    return 0
}

// Fullest real-drive usage % for a sample (mirrors the adapter's headline disk).
export function diskPct(data: any): number {
    const disks = Array.isArray(data?.disks) ? data.disks : []
    if (!disks.length) return 0
    return Math.max(0, Math.min(100, Math.round(Math.max(...disks.map((x: any) => Number(x?.pct) || 0)))))
}

// rows: oldest -> newest, each { data }. os cpu is the delta of cumulative cpu
// times between consecutive samples (instantaneous); others use reported cpu.
// `disk` is only populated for os (the only type carrying a disks[] payload).
export function seriesFromHistory(type: string, rows: { data: any }[]): { cpu: number[]; mem: number[]; disk: number[] } {
    const cpu: number[] = []
    const mem: number[] = []
    const disk: number[] = []
    let prev: { idle: number; total: number } | null = null
    for (const r of rows) {
        const d = r.data || {}
        if (type === "os") {
            const t = osTimes(d)
            if (prev && t.total > prev.total) {
                cpu.push(Math.max(0, Math.min(100, Math.round((1 - (t.idle - prev.idle) / (t.total - prev.total)) * 100))))
            }
            prev = t
            mem.push(memPct(d))
            disk.push(diskPct(d))
        } else {
            cpu.push(directCpu(type, d))
        }
    }
    // os drops the first cpu sample (needs a delta); trim mem/disk to match.
    if (type === "os") {
        if (mem.length > cpu.length) mem.splice(0, mem.length - cpu.length)
        if (disk.length > cpu.length) disk.splice(0, disk.length - cpu.length)
    }
    return { cpu, mem, disk }
}
