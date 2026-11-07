"""Record mu in tmux and write a usemu.dev replay (site/recording/replay-<lang>.json).

usage: recorder.py <lang en|zh> <mu binary> <home> <s-play.json> <out.json> [cols rows]

The replay format: {"cols", "rows", "table": [html line, ...], "frames": [[seconds, [table index per row]], ...],
"marks": {name: frame index}}. A frame is kept whenever the screen changes.
"""
import html
import json
import re
import subprocess
import sys
import threading
import time
import unicodedata

lang, mu, home, script_path, out_path = sys.argv[1:6]
cols, rows = (int(sys.argv[6]), int(sys.argv[7])) if len(sys.argv) > 7 else (84, 30)
SOCK = "murec"
FG, BG = "#e6e6ec", "#0b0b0e"


def tmux(*args, **kw):
    return subprocess.run(["tmux", "-L", SOCK, *args], capture_output=True, text=True, **kw)


env = [
    "env", "-i", f"HOME={home}", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "TERM=xterm-256color",
    "COLORTERM=truecolor", "LANG=en_US.UTF-8", "XIAOMI_API_KEY=placeholder-not-used",
]
if lang == "zh":
    env.append("MU_LANG=zh-CN")
cmd = " ".join(env + [mu, "--use-theme", "mu-dark"])

tmux("kill-server")
tmux("new-session", "-d", "-s", "rec", "-x", str(cols), "-y", str(rows), "-c", f"{home}/code/relay", cmd)

frames, marks = [], {}
lock = threading.Lock()
stop = threading.Event()
t0 = time.monotonic()
last_change = [t0]


def capture():
    r = tmux("capture-pane", "-e", "-p", "-t", "rec")
    lines = r.stdout.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    lines = (lines + [""] * rows)[:rows]
    return lines


def plain(lines):
    return "\n".join(re.sub(r"\x1b\[[0-9;:]*m", "", l) for l in lines)


def watcher():
    prev = None
    while not stop.is_set():
        lines = capture()
        now = time.monotonic()
        if lines != prev:
            with lock:
                frames.append((now - t0, lines))
                last_change[0] = now
            prev = lines
        time.sleep(0.02)


th = threading.Thread(target=watcher, daemon=True)
th.start()


def screen_text():
    with lock:
        return plain(frames[-1][1]) if frames else ""


for step in json.load(open(script_path)):
    if "wait" in step:
        time.sleep(step["wait"])
    elif "until" in step:
        deadline = time.monotonic() + step.get("timeout", 30)
        while not re.search(step["until"], screen_text()):
            if time.monotonic() > deadline:
                stop.set()
                print(screen_text())
                raise SystemExit(f"timed out waiting for {step['until']!r}")
            time.sleep(0.05)
    elif "mark" in step:
        time.sleep(0.1)
        with lock:
            marks[step["mark"]] = len(frames) - 1
    elif "type" in step:
        for ch in step["type"]:
            tmux("send-keys", "-t", "rec", "-l", ch)
            time.sleep(step.get("delay", 0.05))
    elif "key" in step:
        tmux("send-keys", "-t", "rec", "Enter" if step["key"] == "\r" else step["key"])
    elif "idle" in step:
        while time.monotonic() - last_change[0] < step["idle"]:
            time.sleep(0.05)
    else:
        raise SystemExit(f"unknown step {step}")

stop.set()
th.join()
tmux("kill-server")

# ---- ANSI → html lines ----

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
PALETTE16 = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
             "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"]
unhandled = set()


def c256(n):
    if n < 16:
        return PALETTE16[n]
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (v[n // 36], v[n // 6 % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (g, g, g)


def cell(ch):
    e = html.escape(ch)
    o = ord(ch)
    if o < 128 or 0x2500 <= o <= 0x259F:
        return e
    w = "w2" if unicodedata.east_asian_width(ch) in "WF" else "w1"
    return f'<i class="{w}">{e}</i>'


def to_html(line):
    fg = bg = None
    bold = inverse = False
    parts, pos = [], 0

    def emit(text):
        if not text:
            return
        f, b = (fg, bg) if not inverse else (bg or BG, fg or FG)
        style = []
        if f:
            style.append(f"color:{f}")
        if b:
            style.append(f"background:{b}")
        if bold:
            style.append("font-weight:700")
        body = "".join(cell(ch) for ch in text)
        parts.append(f'<span style="{";".join(style)}">{body}</span>' if style else body)

    for m in SGR.finditer(line):
        emit(line[pos : m.start()])
        pos = m.end()
        codes = [int(c) for c in re.split("[;:]", m.group(1)) if c] or [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                fg = bg = None
                bold = inverse = False
            elif c == 1:
                bold = True
            elif c in (2, 22):
                bold = False if c == 22 else bold
            elif c == 7:
                inverse = True
            elif c == 27:
                inverse = False
            elif c in (3, 23, 4, 24, 9, 29):
                pass
            elif c == 39:
                fg = None
            elif c == 49:
                bg = None
            elif c in (38, 48):
                if codes[i + 1] == 2:
                    v = "#%02x%02x%02x" % tuple(codes[i + 2 : i + 5])
                    i += 4
                else:
                    v = c256(codes[i + 2])
                    i += 2
                if c == 38:
                    fg = v
                else:
                    bg = v
            elif 30 <= c <= 37 or 90 <= c <= 97:
                fg = PALETTE16[c - 30 if c < 90 else c - 90 + 8]
            elif 40 <= c <= 47 or 100 <= c <= 107:
                bg = PALETTE16[c - 40 if c < 100 else c - 100 + 8]
            else:
                unhandled.add(c)
            i += 1
    emit(line[pos:])
    # Adjacent spans with the same style merge.
    out = "".join(parts)
    return re.sub(r'<span style="([^"]+)">((?:(?!</span>).)*)</span><span style="\1">', r'<span style="\1">\2', out)


table, index, out_frames = [], {}, []
for t, lines in frames:
    ids = []
    for l in lines:
        h = to_html(l).rstrip(" ")
        if h not in index:
            index[h] = len(table)
            table.append(h)
        ids.append(index[h])
    out_frames.append([round(t, 3), ids])

json.dump({"cols": cols, "rows": rows, "table": table, "frames": out_frames, "marks": marks},
          open(out_path, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(out_frames)} frames, {len(table)} lines, marks {marks}, unhandled SGR {sorted(unhandled)}")
