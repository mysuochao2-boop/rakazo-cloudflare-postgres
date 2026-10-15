import { DurableObject } from "cloudflare:workers";
import type { CloudflareEnv } from "./env.js";

type ContainerInstance = NonNullable<DurableObjectState["container"]>;

const HOME = "/home/rakazo";
const CONTAINER_PATH = `${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const MAX_SCREENS = 16;
const READY_ATTEMPTS = 300;
const RECOVERY_ATTEMPTS = 50;
const SCREEN_SETUP_VERSION = 2;

class ComputerNotRunningError extends Error {}

interface ExecBody {
  argv?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
}

function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

function validId(value: string | null): value is string {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value));
}

function workspaceRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("path escapes the computer workspace");
  }
  return parts.join("/");
}

function workspacePath(value: string): string {
  const relative = workspaceRelative(value);
  return relative ? `${HOME}/${relative}` : HOME;
}

function commandWorkingDirectory(value: string): string {
  // The shared supervisor adapter sends absolute container paths, unlike the
  // relative paths in the file API. Do not prepend HOME a second time.
  if (!value || value === "." || value === "/" || value === HOME) return HOME;
  if (value.startsWith(`${HOME}/`)) return workspacePath(value.slice(HOME.length + 1));
  if (value.startsWith("/")) throw new Error("working directory escapes the computer workspace");
  return workspacePath(value);
}

function text(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

export function containerStartEnv(controlToken: string): Record<string, string> {
  return {
    HOME,
    PATH: CONTAINER_PATH,
    RAKAZO_COMPUTER_CONTROL_TOKEN: controlToken,
  };
}

function screenId(request: Request, computerId: string): string {
  return (
    request.headers.get("x-rakazo-screen-id") ??
    request.headers.get("x-rakazo-bot-id") ??
    computerId
  );
}

function displayEnv(index: number): Record<string, string> {
  return {
    DISPLAY: `:${index + 1}`,
    HOME,
    PATH: CONTAINER_PATH,
    RAKAZO_CDP_PORT: String(9222 + index),
  };
}

function screenSetupScript(index: number, interactive: boolean, profile: string): string {
  const display = index + 1;
  const vncPort = 5900 + index;
  const webPort = 6080 + index;
  const viewOnly = interactive ? "" : "-viewonly";
  return `set -eu
mkdir -p /tmp/rakazo /tmp/.X11-unix /tmp/fluxbox-home-${display}/.fluxbox
if ! xdpyinfo -display :${display} >/dev/null 2>&1; then
  rm -f /tmp/.X${display}-lock /tmp/.X11-unix/X${display}
  nohup Xvfb :${display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp >/tmp/rakazo/xvfb-${display}.log 2>&1 &
  for i in $(seq 1 100); do xdpyinfo -display :${display} >/dev/null 2>&1 && break; sleep 0.1; done
  cp /etc/rakazo/fluxbox/init /tmp/fluxbox-home-${display}/.fluxbox/init
  cp /etc/rakazo/fluxbox/apps /tmp/fluxbox-home-${display}/.fluxbox/apps 2>/dev/null || true
  cp /etc/rakazo/fluxbox/menu /tmp/fluxbox-home-${display}/.fluxbox/menu 2>/dev/null || true
  HOME=/tmp/fluxbox-home-${display} DISPLAY=:${display} nohup fluxbox -rc /tmp/fluxbox-home-${display}/.fluxbox/init >/tmp/rakazo/fluxbox-${display}.log 2>&1 &
fi
mkdir -p ${profile}
printf %s ${profile} >/tmp/rakazo/browser-profile-${display}
if ! (echo >/dev/tcp/127.0.0.1/${9221 + display}) >/dev/null 2>&1; then
  HOME=/home/rakazo DISPLAY=:${display} RAKAZO_BROWSER_PROFILE=${profile} nohup rakazo-browser >/tmp/rakazo/browser-${display}.log 2>&1 &
  for i in $(seq 1 80); do (echo >/dev/tcp/127.0.0.1/${9221 + display}) >/dev/null 2>&1 && break; sleep 0.25; done
fi
if [ -s /tmp/rakazo/x11vnc-${display}.pid ]; then
  kill "$(cat /tmp/rakazo/x11vnc-${display}.pid)" 2>/dev/null || true
fi
if [ -s /tmp/rakazo/novnc-${display}.pid ]; then
  kill "$(cat /tmp/rakazo/novnc-${display}.pid)" 2>/dev/null || true
fi
# Anchor the fallbacks to the executable. An unanchored pkill also matches this
# bash -c script because the command below appears in its own argument string.
pkill -f '^(/usr/bin/)?x11vnc -display :${display} ' 2>/dev/null || true
pkill -f '^(/usr/bin/python3 )?(/usr/bin/)?websockify .*0\\.0\\.0\\.0:${webPort}([[:space:]]|$)' 2>/dev/null || true
ports_closed=0
for i in $(seq 1 50); do
  if ! (echo >/dev/tcp/127.0.0.1/${webPort}) >/dev/null 2>&1 && ! (echo >/dev/tcp/127.0.0.1/${vncPort}) >/dev/null 2>&1; then ports_closed=1; break; fi
  sleep 0.1
done
[ "$ports_closed" = 1 ] || exit 1
nohup x11vnc -display :${display} -forever -shared ${viewOnly} -nopw -listen 127.0.0.1 -rfbport ${vncPort} -xkb -ncache 0 >/tmp/rakazo/x11vnc-${display}.log 2>&1 &
vnc_pid=$!
printf '%s\n' "$vnc_pid" >/tmp/rakazo/x11vnc-${display}.pid
nohup websockify --heartbeat=30 --web=/usr/share/novnc 0.0.0.0:${webPort} 127.0.0.1:${vncPort} >/tmp/rakazo/novnc-${display}.log 2>&1 &
web_pid=$!
printf '%s\n' "$web_pid" >/tmp/rakazo/novnc-${display}.pid
for i in $(seq 1 50); do
  kill -0 "$vnc_pid" "$web_pid" 2>/dev/null || exit 1
  if (echo >/dev/tcp/127.0.0.1/${webPort}) >/dev/null 2>&1 && (echo >/dev/tcp/127.0.0.1/${vncPort}) >/dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
exit 1`;
}

function actionSteps(
  actions: unknown[],
  display: string,
): Array<{ argv?: string[]; waitMs?: number }> {
  return actions.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid action");
    const action = value as Record<string, unknown>;
    if (action.kind === "wait") return { waitMs: Math.max(0, Math.min(Number(action.ms), 5_000)) };
    let command: string[];
    if (action.kind === "key") {
      const modifiers = Array.isArray(action.modifiers) ? action.modifiers : [];
      command = ["xdotool", "key", "--clearmodifiers", [...modifiers, action.key].join("+")];
    } else if (action.kind === "pointer") {
      const button = action.button === "right" ? "3" : "1";
      const position = ["xdotool", "mousemove", "--", String(action.x), String(action.y)];
      command =
        action.type === "move"
          ? position
          : action.type === "down"
            ? [...position, "mousedown", button]
            : action.type === "up"
              ? ["xdotool", "mouseup", button]
              : [...position, "click", button];
    } else if (action.kind === "clipboard") {
      command = ["xdotool", "type", "--clearmodifiers", "--", String(action.text ?? "")];
    } else if (action.kind === "scroll") {
      const amount = Math.max(1, Math.min(Math.round(Number(action.amount ?? 3)), 20));
      command = [
        "xdotool",
        "click",
        "--repeat",
        String(amount),
        action.direction === "up" ? "4" : "5",
      ];
    } else if (action.kind === "open") {
      const target = String(action.path ?? "");
      command = ["xdg-open", /^https?:\/\//i.test(target) ? target : workspacePath(target)];
    } else if (action.kind === "launch" || action.kind === "focus") {
      const application = String(action.application ?? "");
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(application)) throw new Error("invalid application");
      command = [
        ...(action.kind === "focus" ? ["rakazo-focus-or-launch"] : []),
        /^(browser|chrome|chromium|rakazo-browser)$/i.test(application)
          ? "rakazo-browser"
          : application,
        ...(typeof action.uri === "string" ? [action.uri] : []),
      ];
    } else {
      throw new Error("unsupported action");
    }
    return { argv: ["env", `DISPLAY=${display}`, ...command] };
  });
}

export class ComputerContainer extends DurableObject<CloudflareEnv> {
  private readonly screenTransitions = new Map<string, Promise<void>>();

  /** Container fetches may interleave at awaits; transport replacement must stay per-screen. */
  private async withScreenTransition<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.screenTransitions.get(id) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => held);
    this.screenTransitions.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.screenTransitions.get(id) === queued) this.screenTransitions.delete(id);
    }
  }

  private async controlToken(): Promise<string> {
    const existing = await this.ctx.storage.get<string>("controlToken");
    if (existing) return existing;
    const token = crypto.randomUUID().replaceAll("-", "");
    await this.ctx.storage.put("controlToken", token);
    return token;
  }

  private async identify(request: Request): Promise<string> {
    const requested = request.headers.get("x-rakazo-computer-id");
    if (!validId(requested)) throw new Error("invalid computer identity");
    const existing = await this.ctx.storage.get<string>("computerId");
    if (existing && existing !== requested) throw new Error("computer identity mismatch");
    if (!existing) await this.ctx.storage.put("computerId", requested);
    const requestedSpace = request.headers.get("x-rakazo-space-id");
    const existingSpace = await this.ctx.storage.get<string>("spaceId");
    if (existingSpace && requestedSpace && existingSpace !== requestedSpace) {
      throw new Error("computer space mismatch");
    }
    if (!existingSpace && requestedSpace) await this.ctx.storage.put("spaceId", requestedSpace);
    return requested;
  }

  private async ready(allowStart = false): Promise<ContainerInstance> {
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding is unavailable");
    if (!container.running) {
      if (!allowStart) throw new ComputerNotRunningError("Computer is not running");
      // Transport processes live on the ephemeral filesystem, unlike these
      // durable flags. A new container must rebuild them for every screen.
      const setups = await this.ctx.storage.list({ prefix: "screen-setup-version:" });
      for (const key of setups.keys()) await this.ctx.storage.delete(key);
      container.start({
        image: container.images.computer,
        instance: "standard-2",
        enableInternet: true,
        env: containerStartEnv(await this.controlToken()),
      });
    }
    const stopped = container.monitor().then(
      () => {
        throw new Error("Computer container stopped during startup");
      },
      (error: unknown) => {
        console.error("Computer container failed during startup", error);
        const exitCode =
          error && typeof error === "object" && "exitCode" in error
            ? (error as { exitCode?: unknown }).exitCode
            : undefined;
        throw new Error(
          typeof exitCode === "number"
            ? `Computer container failed during startup (exit ${exitCode})`
            : "Computer container failed during startup",
        );
      },
    );
    this.ctx.waitUntil(stopped.catch(() => undefined));
    await container.setInactivityTimeout(60 * 60 * 1000);
    let lastFailure = "port 7070 was unreachable";
    const probe = async () => {
      const ready = await Promise.race([
        container
          .getTcpPort(7070)
          .fetch("http://container/v1/desktop", {
            method: "POST",
            headers: {
              authorization: `Bearer ${await this.controlToken()}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ steps: [], display: ":1", observe: false }),
          })
          .then(async (response) => {
            if (!response.ok) lastFailure = `port 7070 returned HTTP ${response.status}`;
            return response.ok;
          })
          .catch((error: unknown) => {
            lastFailure = error instanceof Error ? error.message : "port 7070 was unreachable";
            return false;
          }),
        stopped,
      ]);
      return ready;
    };
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (await probe()) return container;
      await scheduler.wait(200);
    }
    // PID 1 starts the control server before the desktop. If that child failed
    // without taking down Xvfb, recover it in place instead of leaving a live
    // but unreachable Computer until its inactivity timeout.
    try {
      const recovery = await container.exec(
        [
          "bash",
          "-c",
          "pkill -f '[r]akazo-computer-control' 2>/dev/null || true; nohup /usr/local/bin/rakazo-computer-control >/tmp/rakazo/control.log 2>&1 &",
        ],
        { env: { RAKAZO_COMPUTER_CONTROL_TOKEN: await this.controlToken() } },
      );
      await recovery.output();
      for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
        if (await probe()) return container;
        await scheduler.wait(200);
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : lastFailure;
    }
    try {
      const process = await container.exec(
        [
          "bash",
          "-c",
          "ps -o pid,ppid,stat,comm,args -p 1; pgrep -a -f 'rakazo-computer-control|control.py' || true; ls -la /tmp/rakazo /tmp/rakazo-nss 2>&1; tail -n 80 /tmp/rakazo/control.log 2>&1 || true",
        ],
        { signal: AbortSignal.timeout(5_000) },
      );
      const output = await process.output();
      console.error("Computer container readiness diagnostics", {
        failure: lastFailure,
        exitCode: output.exitCode,
        stdout: text(output.stdout),
        stderr: text(output.stderr),
      });
    } catch (error) {
      console.error("Computer container readiness diagnostics failed", {
        failure: lastFailure,
        error,
      });
    }
    throw new Error("Computer container did not become ready");
  }

  private async assignment(id: string): Promise<number> {
    const key = `screen:${id}`;
    const existing = await this.ctx.storage.get<number>(key);
    if (existing !== undefined) return existing;
    const assignments = await this.ctx.storage.list<number>({ prefix: "screen:" });
    const used = new Set(assignments.values());
    const index = Array.from({ length: MAX_SCREENS }, (_, value) => value).find(
      (value) => !used.has(value),
    );
    if (index === undefined) throw new Error("cannot allocate another screen");
    await this.ctx.storage.put(key, index);
    return index;
  }

  private async screenProfile(id: string): Promise<string> {
    const key = `screen-profile:${id}`;
    const existing = await this.ctx.storage.get<string>(key);
    if (existing) return existing;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    const profile = `${HOME}/.browser-profiles/chromium-bot-${hash}`;
    await this.ctx.storage.put(key, profile);
    return profile;
  }

  private async run(
    container: ContainerInstance,
    argv: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stdin?: string;
    } = {},
  ) {
    const timeout = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 30 * 60_000));
    const response = await container.getTcpPort(7070).fetch("http://container/v1/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.controlToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        argv,
        cwd: options.cwd ?? HOME,
        env: options.env ?? {},
        timeoutMs: timeout,
        stdin: options.stdin ?? "",
      }),
      signal: AbortSignal.timeout(timeout + 5_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Computer command service returned HTTP ${response.status}: ${detail}`);
    }
    const result = (await response.json()) as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
    };
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !Number.isInteger(result.code)
    ) {
      throw new Error("Computer command service returned an invalid response");
    }
    if (result.code !== 0) {
      // Command output can contain credentials or user data. Keep the durable
      // operational signal while logging only the executable and exit code.
      console.error("Computer command failed", {
        command: argv[0],
        exitCode: result.code,
      });
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.code as number };
  }

  private async desktop(
    container: ContainerInstance,
    index: number,
    body: unknown,
  ): Promise<Response> {
    return container.getTcpPort(7070).fetch("http://container/v1/desktop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.controlToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...(body as object), display: `:${index + 1}` }),
    });
  }

  private async ensureScreen(
    container: ContainerInstance,
    id: string,
    index: number,
    interactive: boolean | undefined,
  ): Promise<void> {
    const modeKey = `screen-mode:${id}`;
    const setupKey = `screen-setup-version:${id}`;
    const storedMode = await this.ctx.storage.get<string>(modeKey);
    const setupVersion = await this.ctx.storage.get<number>(setupKey);
    const mode =
      interactive === undefined ? (storedMode ?? "view") : interactive ? "control" : "view";
    if (storedMode === mode && setupVersion === SCREEN_SETUP_VERSION) {
      try {
        const probe = await container
          .getTcpPort(6080 + index)
          .fetch("http://container/embed.html", { method: "HEAD" });
        if (probe.ok) return;
      } catch {
        // Recreate transports after a Container restart.
      }
    }
    const result = await this.run(
      container,
      ["bash", "-c", screenSetupScript(index, mode === "control", await this.screenProfile(id))],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) throw new Error(result.stderr || "screen failed");
    await this.ctx.storage.put(modeKey, mode);
    await this.ctx.storage.put(setupKey, SCREEN_SETUP_VERSION);
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const computerId = await this.identify(request);
      const url = new URL(request.url);
      const portRoute = url.pathname.match(/^\/__port\/(\d+)(\/.*)$/);
      if (portRoute) {
        const port = Number(portRoute[1]);
        if (!Number.isSafeInteger(port) || port < 6080 || port >= 6080 + MAX_SCREENS) {
          return new Response("Not found", { status: 404 });
        }
        url.protocol = "http:";
        url.host = "container";
        url.pathname = portRoute[2]!;
        const forwarded = new Request(url, request);
        forwarded.headers.delete("x-rakazo-computer-id");
        return containerPort(this.ctx.container, port, forwarded);
      }
      const suffix = url.pathname.replace(/^\/computers(?:\/[^/]+)?/, "") || "/";

      if (url.pathname === "/computers" && request.method === "POST") {
        const started = !this.ctx.container?.running;
        await this.ready(true);
        return Response.json({ id: computerId, resumed: !started, started });
      }

      if (suffix === "/" && request.method === "GET") {
        return Response.json({
          id: computerId,
          running: this.ctx.container?.running === true,
          image: "computer",
        });
      }
      if (suffix === "/stop" && request.method === "POST") {
        if (this.ctx.container?.running) await this.ctx.container.destroy();
        return Response.json({ ok: true });
      }
      if (suffix === "/" && request.method === "DELETE") {
        if (this.ctx.container?.running) await this.ctx.container.destroy();
        await this.ctx.storage.deleteAll();
        return Response.json({ ok: true });
      }

      const container = await this.ready();
      if (suffix === "/exec" && request.method === "POST") {
        const body = (await request.json()) as ExecBody;
        if (
          !Array.isArray(body.argv) ||
          body.argv.length === 0 ||
          !body.argv.every((part) => typeof part === "string")
        ) {
          return jsonError("invalid argv");
        }
        const index = await this.assignment(screenId(request, computerId));
        const env =
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? (body.env as Record<string, string>)
            : {};
        return Response.json(
          await this.run(container, body.argv, {
            cwd: typeof body.cwd === "string" ? commandWorkingDirectory(body.cwd) : HOME,
            env: { ...displayEnv(index), ...env },
            timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          }),
        );
      }
      if (suffix === "/browser" && request.method === "POST") {
        const id = screenId(request, computerId);
        const index = await this.assignment(id);
        await this.ensureScreen(container, id, index, undefined);
        const body = await request.json();
        const browserBody = body as { command?: string; actions?: Array<{ origin?: unknown }> };
        const carriesSavedLogin =
          browserBody.command === "act" && browserBody.actions?.some((step) => step.origin);
        const result = await this.run(
          container,
          [
            "/usr/local/bin/rakazo-page-browser",
            String(browserBody.command),
            ...(carriesSavedLogin ? [] : [JSON.stringify(body)]),
          ],
          {
            env: {
              ...displayEnv(index),
              RAKAZO_BROWSER_WATCH_STDIN: "1",
              RAKAZO_BROWSER_ARGS_STDIN: "1",
            },
            timeoutMs: 25_000,
            stdin: `${JSON.stringify(body)}\n`,
          },
        );
        return result.code === 0
          ? Response.json(JSON.parse(result.stdout))
          : Response.json({
              ok: false,
              fallback: "computer_act",
              uncertain: true,
              error: result.stderr,
            });
      }
      if ((suffix === "/observe" || suffix === "/actions") && request.method === "POST") {
        const id = screenId(request, computerId);
        const index = await this.assignment(id);
        await this.ensureScreen(container, id, index, undefined);
        if (suffix === "/observe")
          return this.desktop(container, index, { steps: [], observe: true });
        const body = (await request.json()) as {
          actions?: unknown[];
          observe?: boolean;
          settleMs?: number;
        };
        return this.desktop(container, index, {
          steps: actionSteps(body.actions ?? [], `:${index + 1}`),
          observe: body.observe !== false,
          settleMs: body.settleMs ?? 0,
        });
      }
      if (suffix === "/input" && request.method === "POST") {
        const index = await this.assignment(screenId(request, computerId));
        const body = (await request.json()) as { input?: unknown; leaseId?: string };
        const response = await this.desktop(container, index, {
          steps: actionSteps([body.input], `:${index + 1}`),
          observe: false,
        });
        return response.ok ? Response.json({ ok: true, leaseId: body.leaseId ?? null }) : response;
      }
      if (suffix === "/files" && request.method === "GET") {
        const relative = workspaceRelative(url.searchParams.get("path") ?? "");
        if (url.searchParams.get("mode") === "read") {
          const limit = Number(url.searchParams.get("maxBytes") ?? -1);
          if (!relative || !Number.isSafeInteger(limit) || limit < -1) {
            return jsonError("invalid file read");
          }
          const script =
            "import base64,os,sys\nrel,n=sys.argv[1],int(sys.argv[2]); parts=[x for x in rel.split('/') if x]; fd=os.open('/home/rakazo',os.O_RDONLY|os.O_DIRECTORY)\ntry:\n for x in parts[:-1]:\n  nxt=os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nxt\n f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)\n with os.fdopen(f,'rb') as src: b=src.read() if n<0 else src.read(n+1)\nfinally: os.close(fd)\nif n>=0 and len(b)>n: sys.exit(42)\nprint(base64.b64encode(b).decode())";
          const result = await this.run(container, [
            "python3",
            "-c",
            script,
            relative,
            String(limit),
          ]);
          if (result.code === 42) return jsonError("computer file exceeds limit", 413);
          if (result.code !== 0) return jsonError("file not found", 404);
          return Response.json({ content: result.stdout.trim() });
        }
        const script =
          "import json,os,stat,sys\nrel=sys.argv[1]; fd=os.open('/home/rakazo',os.O_RDONLY|os.O_DIRECTORY)\ntry:\n for x in filter(None,rel.split('/')):\n  nxt=os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nxt\n out=[]\n for x in os.scandir(fd):\n  if x.is_symlink(): continue\n  s=x.stat(follow_symlinks=False); p='/'.join(filter(None,[rel,x.name])); out.append({'path':p,'kind':'dir' if x.is_dir(follow_symlinks=False) else 'file','size':s.st_size,**({'executable':True} if x.is_file(follow_symlinks=False) and s.st_mode & stat.S_IXUSR else {})})\nfinally: os.close(fd)\nprint(json.dumps(sorted(out,key=lambda x:x['path'])))";
        const result = await this.run(container, ["python3", "-c", script, relative]);
        return result.code === 0
          ? Response.json(JSON.parse(result.stdout))
          : jsonError("directory not found", 404);
      }
      if (suffix === "/files" && request.method === "POST") {
        const body = (await request.json()) as {
          path?: string;
          content?: string;
          executable?: boolean;
        };
        if (typeof body.path !== "string" || typeof body.content !== "string")
          return jsonError("invalid file");
        const relative = workspaceRelative(body.path);
        if (!relative) return jsonError("invalid file");
        const script =
          "import base64,os,sys\nrel,ex=sys.argv[1:3]; parts=[x for x in rel.split('/') if x]; fd=os.open('/home/rakazo',os.O_RDONLY|os.O_DIRECTORY)\ntry:\n for x in parts[:-1]:\n  try: os.mkdir(x,0o700,dir_fd=fd)\n  except FileExistsError: pass\n  nxt=os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nxt\n out=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o700 if ex=='1' else 0o600,dir_fd=fd)\n with os.fdopen(out,'wb') as dst: dst.write(base64.b64decode(sys.stdin.read(),validate=True))\nfinally: os.close(fd)";
        const result = await this.run(
          container,
          ["python3", "-c", script, relative, body.executable ? "1" : "0"],
          { stdin: body.content },
        );
        return result.code === 0
          ? Response.json({ ok: true })
          : jsonError("file write failed", 500);
      }
      if (suffix === "/screen-mode" && request.method === "POST") {
        const body = (await request.json()) as {
          interactive?: boolean;
          controlToken?: unknown;
          revokeControl?: unknown;
        };
        const interactive = body.interactive === true;
        const controlToken =
          typeof body.controlToken === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.controlToken)
            ? body.controlToken
            : undefined;
        if (interactive && !controlToken)
          return jsonError("interactive screen requires control token");
        const id = screenId(request, computerId);
        const index = await this.assignment(id);
        await this.withScreenTransition(id, async () => {
          const tokenKey = `screen-control-token:${id}`;
          const revokedTokenKey = `screen-revoked-control-token:${id}`;
          if (!interactive && body.revokeControl === false) {
            // A preview is client-side read-only. It must not downgrade an existing control
            // transport, especially when an older preview request arrives after takeover.
            await this.ensureScreen(container, id, index, undefined);
            return;
          }
          if (!interactive) {
            const activeToken = await this.ctx.storage.get<string>(tokenKey);
            // A delayed release from an older lease cannot revoke a newer control session.
            if (activeToken && controlToken && activeToken !== controlToken) return;
            await this.ensureScreen(container, id, index, false);
            if (controlToken ?? activeToken) {
              await this.ctx.storage.put(revokedTokenKey, controlToken ?? activeToken!);
            }
            await this.ctx.storage.delete(tokenKey);
            return;
          }
          const activeToken = await this.ctx.storage.get<string>(tokenKey);
          const revokedToken = await this.ctx.storage.get<string>(revokedTokenKey);
          // A connectScreen call that was already in flight when this lease was released
          // must not turn the transport interactive again.
          if (controlToken === revokedToken || (activeToken && activeToken !== controlToken))
            return;
          await this.ensureScreen(container, id, index, true);
          await this.ctx.storage.put(tokenKey, controlToken);
        });
        const port = 6080 + index;
        return Response.json({
          screenUrl: `http://computer.internal:${port}/${encodeURIComponent(computerId)}/embed.html?view_only=${interactive ? "false" : "true"}`,
        });
      }
      if (suffix === "/terminal" && request.method === "POST") {
        const id = screenId(request, computerId);
        const index = await this.assignment(id);
        await this.ensureScreen(container, id, index, true);
        await this.run(container, [
          "bash",
          "-c",
          `DISPLAY=:${index + 1} nohup xterm >/tmp/rakazo/terminal-${index + 1}.log 2>&1 &`,
        ]);
        return Response.json({
          terminalUrl: `http://computer.internal:${6080 + index}/${encodeURIComponent(computerId)}/embed.html?view_only=false`,
        });
      }
      if (suffix === "/screen" && request.method === "DELETE") {
        const id = screenId(request, computerId);
        const index = await this.ctx.storage.get<number>(`screen:${id}`);
        if (index !== undefined) {
          const profile = await this.screenProfile(id);
          const display = index + 1;
          const result = await this.run(container, [
            "bash",
            "-c",
            `pkill -f '[x]11vnc -display :${display} ' || true
pkill -f '[w]ebsockify.*:${6080 + index}' || true
# Anchor to the browser executable so this bash script cannot match itself.
pkill -f -- '^(/[^ ]*/)?(chromium|chrome|chromium-browser) .*--user-data-dir=${profile}([[:space:]]|$)' || true
for i in $(seq 1 40); do ! (echo >/dev/tcp/127.0.0.1/${9221 + display}) >/dev/null 2>&1 && break; sleep 0.25; done
rm -f /tmp/rakazo/browser-profile-${display}
${index === 0 ? "" : `pkill -f '[X]vfb :${display} -screen' || true; pkill -f '[f]luxbox -rc /tmp/fluxbox-home-${display}' || true`}`,
          ]);
          if (result.code !== 0) throw new Error("screen cleanup failed");
          await this.ctx.storage.delete(`screen:${id}`);
          await this.ctx.storage.delete(`screen-mode:${id}`);
          await this.ctx.storage.delete(`screen-setup-version:${id}`);
          await this.ctx.storage.delete(`screen-control-token:${id}`);
          await this.ctx.storage.delete(`screen-revoked-control-token:${id}`);
        }
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      // Only provisioning may create a new filesystem. Returning a missing
      // Computer lets the backend restore its checkpoint before further use.
      if (error instanceof ComputerNotRunningError) return jsonError("computer not found", 404);
      console.error("Computer request failed", error);
      return jsonError(error instanceof Error ? error.message : "computer request failed", 500);
    }
  }
}

async function containerPort(
  candidate: ContainerInstance | undefined,
  port: number,
  request: Request,
): Promise<Response> {
  if (!candidate?.running) return new Response("Computer is not running", { status: 404 });
  return candidate.getTcpPort(port).fetch(request);
}
