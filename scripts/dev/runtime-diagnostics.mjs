import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector/promises";
import { getHeapStatistics } from "node:v8";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

function seconds(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Invalid diagnostic interval");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error("Diagnostic interval out of range");
  }
  return parsed;
}

export function diagnosticConfig(env = process.env) {
  if (env.OMNIROUTE_RUNTIME_DIAGNOSTICS !== "1") return null;
  return {
    delaySeconds: seconds(env.OMNIROUTE_DIAGNOSTICS_DELAY_SECONDS, 120, 0, 3600),
    durationSeconds: seconds(env.OMNIROUTE_DIAGNOSTICS_DURATION_SECONDS, 180, 1, 300),
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// CPU profiles contain stacks, not heap objects. Keep only profiling fields;
// strip query/fragment text from source URLs before writing private artifacts.
export function sanitizeCpuProfile(profile) {
  return {
    startTime: profile.startTime,
    endTime: profile.endTime,
    samples: profile.samples,
    timeDeltas: profile.timeDeltas,
    nodes: profile.nodes.map((node) => ({
      id: node.id,
      hitCount: node.hitCount,
      children: node.children,
      callFrame: {
        functionName: node.callFrame.functionName,
        scriptId: node.callFrame.scriptId,
        url: /^(?:https?:|data:)/i.test(node.callFrame.url)
          ? "[external script]"
          : node.callFrame.url.split(/[?#]/, 1)[0],
        lineNumber: node.callFrame.lineNumber,
        columnNumber: node.callFrame.columnNumber,
      },
    })),
  };
}

export async function captureRuntimeDiagnostics(durationSeconds) {
  seconds(String(durationSeconds), 180, 1, 300);
  const directory = await mkdtemp(join(tmpdir(), "omniroute-diagnostics-"));
  const session = new Session();
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const samples = [];
  let gc = {};
  let previousUtilization = performance.eventLoopUtilization();
  let previousCpu = process.cpuUsage();
  let previousTime = performance.now();
  const startedAt = new Date().toISOString();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = String(entry.detail.kind);
      const group = (gc[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
      group.count++;
      group.totalMs += entry.duration;
      group.maxMs = Math.max(group.maxMs, entry.duration);
    }
  });
  function sample() {
    const now = performance.now();
    const usage = process.cpuUsage();
    const utilization = performance.eventLoopUtilization();
    const heap = getHeapStatistics();
    samples.push({
      utc: new Date().toISOString(),
      intervalMs: now - previousTime,
      cpuUserMicros: usage.user - previousCpu.user,
      cpuSystemMicros: usage.system - previousCpu.system,
      eventLoop: performance.eventLoopUtilization(utilization, previousUtilization),
      delayMs: {
        p50: histogram.percentile(50) / 1e6,
        p95: histogram.percentile(95) / 1e6,
        p99: histogram.percentile(99) / 1e6,
        max: histogram.max / 1e6,
      },
      memory: process.memoryUsage(),
      heap: {
        limitBytes: heap.heap_size_limit,
        usedBytes: heap.used_heap_size,
        totalBytes: heap.total_heap_size,
      },
      gc,
    });
    gc = {};
    histogram.reset();
    previousCpu = usage;
    previousTime = now;
    previousUtilization = utilization;
    // An attached inspector can retain console argument objects. Do not retain
    // production log payloads for the duration of the profile.
    void session.post("Runtime.discardConsoleEntries").catch(() => {});
  }
  let timer;
  try {
    // In-process session only: never call inspector.open(), listen on a port,
    // enable Debugger, pause execution, or collect a heap snapshot.
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1000 });
    observer.observe({ entryTypes: ["gc"] });
    histogram.enable();
    await session.post("Profiler.start");
    sample();
    timer = setInterval(sample, 1000);
    timer.unref();
    await delay(durationSeconds * 1000);
    const { profile } = await session.post("Profiler.stop");
    // Allow queued GC performance entries to reach the observer.
    await new Promise((resolve) => setImmediate(resolve));
    sample();
    clearInterval(timer);
    observer.disconnect();
    histogram.disable();
    session.disconnect();
    const report = { pid: process.pid, node: process.version, startedAt, samples };
    await writeFile(join(directory, "telemetry.json"), JSON.stringify(report), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      join(directory, "cpu.cpuprofile"),
      JSON.stringify(sanitizeCpuProfile(profile)),
      {
        mode: 0o600,
        flag: "wx",
      }
    );
    return directory;
  } finally {
    clearInterval(timer);
    observer.disconnect();
    histogram.disable();
    session.disconnect();
  }
}

export async function runRuntimeDiagnostics(env = process.env) {
  try {
    const config = diagnosticConfig(env);
    if (!config) return null;
    console.log(
      `[runtime-diagnostics] scheduled delay=${config.delaySeconds}s duration=${config.durationSeconds}s`
    );
    await delay(config.delaySeconds * 1000);
    const directory = await captureRuntimeDiagnostics(config.durationSeconds);
    console.log(`[runtime-diagnostics] completed directory=${directory}`);
    return directory;
  } catch {
    // Optional diagnostics must not take down the server or log exception data.
    console.warn("[runtime-diagnostics] capture failed; server continues normally");
    return null;
  }
}
