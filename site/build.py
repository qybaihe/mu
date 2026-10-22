"""Build usemu.dev, the mu site: five languages; home, decision points, docs and changelog.

The facts come from the mu repository, so a rebuild follows the product:
  packages/kyrn-judge/manifest.json   the decision points, features and options, with their names in every language
  README.md, docs/readme/README.<lang>.md
                                      each decision point's question, and the measurements on the decision point page
  docs/readme/bench-*.svg             the charts of those measurements
  CHANGELOG.md                        the changelog: every release in English, and in a language that has no
                                      translation of a release yet
  desktop/.../i18n/locales/<locale>/agentMode.json
                                      the permission modes' names, which the build checks the pages against
and from GitHub's API, at build time:
  the releases (pre-releases while mu is 0.x, so not /releases/latest): the newest one gives the banner, the version
  and the download links; each one names a CHANGELOG.md section; kyrn/npm/package.template.json at its tag says
  which mu-agent it bundles

The site's own words and assets:
  templates/                       Jinja2 templates
  i18n/<lang>.json                 the home page, the navigation, the banner and the translated changelog
  content/decisions.<lang>.json    the decision point page: explanations and one example per point
  content/docs/<lang>/*.md         the documentation pages (a missing one falls back to English)
  content/docs-ui.<lang>.json      the words around the documentation
  recording/                       the terminal replay on the home page: mu 0.1.10 in ~/code/relay with the free Jev.
                                   Jev's verdicts and timings are real; the coding model's replies are scripted
  static/                          shared CSS and JS, _headers and _redirects
  assets/                          icons, the link preview image, screenshots and the folding video

In any of the site's own text, {points} is the number of decision points and {points_active} the number that act
from the start (their feature is on by default).

usage: python3 build.py <outdir> [--repo <mu checkout>]      (pip install -r requirements.txt first)
  The repository defaults to $MU_REPO, then to the folder above this one (site/ inside mu).
  The Chinese pages go to <outdir>/, the others to <outdir>/<lang>/.
  GITHUB_TOKEN or GH_TOKEN, when set, is sent to GitHub's API for a higher rate limit.
"""
import argparse
import base64
import hashlib
import html
import json
import os
import posixpath
import re
import shutil
import subprocess
import unicodedata
import urllib.request
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markdown_it import MarkdownIt

here = Path(__file__).resolve().parent
SITE = "https://usemu.dev/"
REPO = "https://github.com/qybaihe/mu"
API = "https://api.github.com/repos/qybaihe/mu"
LOCALES = ["zh-CN", "en", "zh-TW", "ja", "ko"]
MANIFEST_LANG = {"zh-CN": "zh", "en": "en", "zh-TW": "zh-TW", "ja": "ja-JP", "ko": "ko-KR"}
APP_LOCALE = {"zh-CN": "zh-CN", "en": "en-US", "zh-TW": "zh-TW", "ja": "ja-JP", "ko": "ko-KR"}
OG_LOCALE = {"zh-CN": "zh_CN", "en": "en_US", "zh-TW": "zh_TW", "ja": "ja_JP", "ko": "ko_KR"}
DOCS = [
    ("getting-started", "start"), ("desktop", "start"), ("cli", "start"),
    ("judges", "use"), ("permissions", "use"), ("goal", "use"), ("context", "use"), ("lessons", "use"), ("board", "use"), ("hive", "use"),
    ("configuration", "ref"), ("options", "ref"), ("troubleshooting", "ref"), ("privacy", "ref"),
]
PAGES = {
    "home": {"key": "home", "path": ""},
    "docs": {"key": "docs", "path": "docs/"},
    "decisions": {"key": "decisions", "path": "decisions/"},
    "changelog": {"key": "changelog", "path": "changelog/"},
}
for _slug, _ in DOCS:
    PAGES[f"docs/{_slug}"] = {"key": f"docs-{_slug}", "path": f"docs/{_slug}/"}
# Images the README links in docs/readme/, as the site publishes them. The charts are copied from the repository;
# the screenshots are smaller WebP copies kept in assets/.
README_ASSETS = {
    "swarm.png": "assets/swarm.en.webp",
    "board.png": "assets/board.en.webp",
    "swarm.zh-CN.png": "assets/swarm.zh.webp",
    "board.zh-CN.png": "assets/board.zh.webp",
    "bench-test-log-judge-light.svg": "assets/readme/bench-test-log-judge-light.svg",
    "bench-test-log-judge-dark.svg": "assets/readme/bench-test-log-judge-dark.svg",
    "bench-test-log-repeats-light.svg": "assets/readme/bench-test-log-repeats-light.svg",
    "bench-test-log-repeats-dark.svg": "assets/readme/bench-test-log-repeats-dark.svg",
}
# The desktop app's screenshots come in the app's English and Chinese (a language's "shots" picks one).
SHOTS = [f"{name}.{shots}.webp" for name in ("app-light", "app-dark", "swarm", "board") for shots in ("en", "zh")]
SITE_ASSETS = ["icon-256.png", "favicon-64.png", "apple-touch-icon.png", "og.jpg", *SHOTS]
# The download buttons, by the end of an installer's name (mu-0.1.8-mac-arm64.dmg).
DOWNLOADS = ["mac-arm64.dmg", "mac-x64.dmg", "win-x64.exe", "linux-amd64.deb"]
md = MarkdownIt("commonmark", {"html": True}).enable("table")
WARNINGS = []


def warn(text):
    WARNINGS.append(text)


def readme_repo_path(lang):
    return "README.md" if lang == "en" else f"docs/readme/README.{lang}.md"


def load_json(name, lang):
    path = here / "content" / f"{name}.{lang}.json"
    return json.loads((path if path.exists() else here / "content" / f"{name}.en.json").read_text())


def fill(value, facts):
    """{points} and {points_active} in a string, or in every string of a list or dict."""
    if isinstance(value, str):
        for key, number in facts.items():
            value = value.replace("{" + key + "}", str(number))
        return value
    if isinstance(value, list):
        return [fill(v, facts) for v in value]
    if isinstance(value, dict):
        return {k: fill(v, facts) for k, v in value.items()}
    return value


# ---- GitHub ----

def github(path):
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "usemu-site-build"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(API + path, headers=headers), timeout=30) as response:
        return json.load(response)


def version_key(number):
    return tuple(int(x) for x in number.split("."))


def mu_releases():
    """Published desktop releases, newest first: tags vX.Y.Z with mu's installers. Drafts and other tags are left out."""
    out = []
    for r in github("/releases?per_page=100"):
        m = re.fullmatch(r"v(\d+\.\d+\.\d+)", r["tag_name"])
        if r.get("draft") or not m:
            continue
        number = m.group(1)
        assets = {a["name"]: a["browser_download_url"] for a in r.get("assets", [])}
        if not any(name.startswith(f"mu-{number}-") for name in assets):
            continue
        out.append({"tag": r["tag_name"], "number": number, "date": (r.get("published_at") or "")[:10],
                    "url": r["html_url"], "assets": assets, "body": r.get("body") or ""})
    if not out:
        raise SystemExit("GitHub lists no mu release")
    return sorted(out, key=lambda r: version_key(r["number"]), reverse=True)


def bundled_agent(release, repo):
    """The mu-agent version a desktop release bundles: kyrn/npm/package.template.json at its tag."""
    path = "kyrn/npm/package.template.json"
    try:
        out = subprocess.run(["git", "-C", str(repo), "show", f"{release['tag']}:{path}"], capture_output=True, text=True, timeout=20)
        if out.returncode == 0:
            return json.loads(out.stdout)["version"]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    try:
        data = github(f"/contents/{path}?ref={release['tag']}")
        return json.loads(base64.b64decode(data["content"]))["version"]
    except (OSError, ValueError, KeyError):
        pass
    m = re.search(r"mu-agent (\d+\.\d+\.\d+)", release["body"])
    return m.group(1) if m else None


def star_count():
    try:
        return int(github("")["stargazers_count"])
    except (OSError, ValueError, KeyError):
        return None


def format_stars(n):
    if n is None:
        return ""
    if n >= 10000:
        return f"{round(n / 1000)}k"
    if n >= 1000:
        return f"{n / 1000:.1f}".rstrip("0").rstrip(".") + "k"
    return str(n)


# ---- The repository ----

def changelog_sections(repo):
    """CHANGELOG.md: version → {date, body}. [Unreleased] and the link definitions at the end are left out."""
    text = (repo / "CHANGELOG.md").read_text()
    text = re.sub(r"^\[[^\]]+\]: \S+[ \t]*$", "", text, flags=re.M)
    parts = re.split(r"^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?[ \t]*$", text, flags=re.M)
    sections = {}
    for i in range(1, len(parts) - 2, 3):
        version, date, body = parts[i].strip(), parts[i + 1], parts[i + 2].strip()
        if re.fullmatch(r"\d+\.\d+\.\d+", version):
            sections[version] = {"date": date or "", "body": body}
    return sections


def mode_labels(repo, lang):
    """The permission modes' names in the desktop app: full, judge, ask."""
    path = repo / "desktop/packages/desktop/src/renderer/services/i18n/locales" / APP_LOCALE[lang] / "agentMode.json"
    try:
        data = json.loads(path.read_text())
        return {k: data[k] for k in ("full", "judge", "ask")}
    except (OSError, ValueError, KeyError):
        warn(f"{lang}: no permission mode names in {path.relative_to(repo)}")
        return {}


# ---- Recordings ----

def load_recording(name):
    replay = json.loads((here / "recording" / f"replay-{name}.json").read_text())
    script = json.loads((here / "recording" / ("s-play.json" if name == "zh" else f"s-play-{name}.json")).read_text())
    prompt = next(step["type"] for step in script if "type" in step)
    table, frames = replay["table"], replay["frames"]
    text = ["\n".join(re.sub(r"<[^>]+>", "", table[r]) for r in ids) for _, ids in frames]

    def first(needle, start=0):
        for i in range(start, len(text)):
            if needle in text[i]:
                return i
        raise SystemExit(f"{name}: no frame contains {needle!r}")

    def first_line(prefix, start=0):
        """The first frame with a line that starts with prefix: a tool's own line, not prose that mentions it."""
        for i in range(start, len(text)):
            if any(line.lstrip().startswith(prefix) for line in text[i].split("\n")):
                return i
        raise SystemExit(f"{name}: no frame has a line starting with {prefix!r}")

    verdict = first("◆ Jev")
    bash1 = first("$ npm test", verdict)
    edit = first_line("edit ", bash1)
    passed = first("fail 0", edit)
    segments = {
        "start": [replay["marks"]["welcome"], bash1 - 1],
        "fail": [bash1, edit - 1],
        "edit": [edit, passed - 1],
        "done": [passed, len(frames) - 1],
    }
    ms = re.search(r"full effort · (\d+) ms", text[verdict])
    data = {"table": table, "frames": [[round(t, 3), ids] for t, ids in frames], "segments": segments, "marks": {"verdict": verdict}}
    return {
        "blob": json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"),
        "final": "\n".join(table[r] for r in frames[-1][1]),
        "verdict_ms": ms.group(1) if ms else "700",
        "prompt": html.escape(prompt),
        "segments": segments,
    }


# ---- Links and markdown ----

class Page:
    """Link helpers for one rendered page."""

    def __init__(self, L, page):
        self.L, self.page = L, page
        depth = (L["path"] + page["path"]).count("/")
        self.root = "../" * depth

    def url(self, X, P):
        return (self.root + X["path"] + P["path"]) or "./"

    def site_link(self, target):
        """`@docs/judges#jev`, `@decisions#tool.risk`, `@home#install`, `@changelog` → a link from this page."""
        name, _, frag = target[1:].partition("#")
        key = name or "home"
        if key not in PAGES:
            raise SystemExit(f"unknown site link {target}")
        base = "" if PAGES[key]["key"] == self.page["key"] else self.url(self.L, PAGES[key])
        return base + (f"#{frag}" if frag else "") if base or frag else "./"


def code_blocks(out):
    def code(m):
        attrs, body = m.group(1), m.group(2)
        if 'class="language-bash"' in attrs:
            body = re.sub(r"(^|\s)(#[^\n]*)", r'\1<span class="c">\2</span>', body, flags=re.M)
            return f"<pre><code{attrs}>{body}</code></pre>"
        if re.search("[─│▶▼▲┘└┐┌]", body):
            return f'<pre class="diagram"><code{attrs}>{fixed_width(body)}</code></pre>'
        return m.group(0)

    return re.sub(r"<pre><code([^>]*)>(.*?)</code></pre>", code, out, flags=re.S)


def fixed_width(text):
    """Pin each character of a box diagram to its terminal width, as the replay does: fallback fonts
    draw CJK, arrows and dots at widths that are not whole columns, and the box edges drift."""
    out = []
    for c in html.unescape(text):
        e = html.escape(c, quote=False)
        if unicodedata.east_asian_width(c) in ("W", "F"):
            out.append(f'<i class="w2">{e}</i>')
        elif ord(c) > 127 and not 0x2500 <= ord(c) <= 0x259F:
            out.append(f'<i class="w1">{e}</i>')
        else:
            out.append(e)
    return "".join(out)


def render_repo_markdown(text, repo_file, ctx):
    """Markdown from the repository: its relative links become GitHub links (or the site's own pages), its images the
    site's copies."""
    out = md.render(text)
    base_dir = posixpath.dirname(repo_file)

    def resolve(url):
        if re.match(r"^[a-z]+:", url) or url.startswith("#"):
            return url
        path, _, frag = html.unescape(url).partition("#")
        repo_path = posixpath.normpath(posixpath.join(base_dir, path))
        name = posixpath.basename(repo_path)
        if repo_path == "docs/reference/decision-points.md":
            return ctx.site_link("@decisions")
        if repo_path == "CHANGELOG.md":
            return ctx.site_link("@changelog")
        if repo_path.startswith("docs/readme/") and name in README_ASSETS:
            return ctx.root + README_ASSETS[name]
        return f"{REPO}/blob/main/{repo_path}" + (f"#{frag}" if frag else "")

    out = re.sub(r'(href|src|srcset)="([^"]*)"', lambda m: f'{m.group(1)}="{resolve(m.group(2))}"', out)
    # Light and dark charts: two images, shown by the page's theme (a <picture> follows only the system).
    out = re.sub(
        r'<picture>\s*<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">\s*<img src="([^"]+)"([^>]*)>\s*</picture>',
        lambda m: f'<img class="only-light" src="{m.group(2)}"{m.group(3)}><img class="only-dark" src="{m.group(1)}"{m.group(3)}>',
        out,
    )
    # The folding demo as a video: 476 KB instead of a 2.2 MB GIF.
    out = re.sub(
        r'<img src="[^"]*test-log-folding\.gif"[^>]*?alt="([^"]*)"[^>]*>',
        lambda m: (
            f'<video data-autoplay muted loop playsinline preload="metadata" width="960" height="560" aria-label="{m.group(1)}"'
            f' poster="{ctx.root}assets/readme/test-log-folding-poster.webp">'
            f'<source src="{ctx.root}assets/readme/test-log-folding.mp4" type="video/mp4"></video>'
        ),
        out,
    )
    out = out.replace('<p align="center">', '<p class="figure">')
    out = out.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")
    return code_blocks(out)


def render_doc(text, ctx, toc):
    """A documentation page: `{#id}` heading anchors, `@` site links, tables and code."""
    out = md.render(text)

    def heading(m):
        level, inner, hid = m.group(1), m.group(2).strip(), m.group(3)
        if level == "2":
            toc.append({"id": hid, "text": html.unescape(re.sub(r"<[^>]+>", "", inner))})
        return f'<h{level} id="{hid}">{inner}</h{level}>'

    out = re.sub(r"<h([23])>(.*?)\{#([\w.-]+)\}</h\1>", heading, out)
    if re.search(r"<h2>", out):
        raise SystemExit(f"{ctx.L['lang']} {ctx.page['key']}: a heading without an {{#id}}")
    out = re.sub(r'href="(@[^"]*)"', lambda m: f'href="{ctx.site_link(html.unescape(m.group(1)))}"', out)
    out = out.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")
    return code_blocks(out)


def readme_parts(repo, lang):
    """The two parts of a README the decision point page uses, found by what they hold rather than where they are:
    the section with the decision point tables, and the one with the measurements' charts."""
    src = (repo / readme_repo_path(lang)).read_text()
    parts = re.split(r"^## (.+)$", src, flags=re.M)[1:]
    sections = [(parts[i].strip(), parts[i + 1]) for i in range(0, len(parts), 2)]
    points = next((s for s in sections if re.search(r"^\|\s*`input\.preflight`", s[1], flags=re.M)), None)
    measured = next((s for s in sections if "bench-test-log-" in s[1]), None)
    if not points or not measured:
        raise SystemExit(f"{readme_repo_path(lang)}: no decision point tables or no measurements")
    return points, measured


def readme_questions(body):
    """The decision point tables of the README: id → its question."""
    rows = re.findall(r"^\|\s*`([\w.-]+)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$", body, flags=re.M)
    return {pid: md.renderInline(q) for pid, q, _ in rows}


# ---- Documentation ----

def load_doc(lang, slug):
    path = here / "content" / "docs" / lang / f"{slug}.md"
    if not path.exists():
        path = here / "content" / "docs" / "en" / f"{slug}.md"
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise SystemExit(f"{path}: no front matter")
    front = dict(re.findall(r"^(\w+):\s*(.*)$", m.group(1), flags=re.M))
    return front, text[m.end():]


# "Wait at most", "Only filter output longer than", "Every": labels the app shows in front of an input. In English
# they get their default, so they read as sentences (as scripts/write-docs-reference.mjs does for the reference).
LEADS_INTO_VALUE = re.compile(r"( at most|than)$|^Every$")


def render_options(manifest, lang, ctx, U, toc):
    """Every feature and option, from the manifest, in this language."""
    ml = MANIFEST_LANG[lang]

    def t(value):
        return value.get(ml) or value.get("en", "") if isinstance(value, dict) else value

    def code(v):
        return f"<code>{html.escape(str(v))}</code>"

    def default(o, plain=False):
        v, unit = o.get("default"), t(o.get("unit")) if o.get("unit") else ""
        if o["kind"] == "boolean":
            return code("true" if v else "false")
        if o["kind"] in ("list", "numbers"):
            return ", ".join(code(x) for x in v) if v else html.escape(U["options_empty"])
        if v in ("", None):
            return html.escape(U["options_empty"])
        if plain:
            return html.escape(f"{v} {unit}" if unit else str(v))
        return f'<span class="opt-def">{code(v)}{f" {html.escape(unit)}" if unit else ""}</span>'

    cjk = lang in ("zh-CN", "zh-TW", "ja")
    stop, gap = ("。", "") if cjk else (".", " ")

    def sentence(text):
        return text if text.endswith(("。", ".", "？", "?", "！", "!")) else text + stop

    owners = {}
    for d in manifest["decisions"]:
        owners.setdefault(d["feature"], []).append(d["id"])
    parts = []
    for f in manifest["features"]:
        fid = f"feature-{f['name']}"
        title = html.escape(t(f["title"]))
        toc.append({"id": fid, "text": t(f["title"])})
        flags = [f'<span class="opt-flag {"on" if f.get("defaultEnabled") else "off"}">'
                 f'{html.escape(U["options_on"] if f.get("defaultEnabled") else U["options_off"])}</span>']
        if f.get("beta"):
            flags.append(f'<span class="opt-flag beta">{html.escape(U["options_beta"])}</span>')
        points = owners.get(f["name"], [])
        if points:
            links = " ".join(f'<a href="{ctx.site_link("@decisions#" + p)}"><code>{p}</code></a>' for p in points)
            flags.append(f'<span class="opt-points">{html.escape(U["options_points"])} {links}</span>')
        rows = []
        for o in f.get("options", []):
            label, help_text = t(o["label"]), t(o["help"]) if o.get("help") else ""
            leads = lang == "en" and LEADS_INTO_VALUE.search(label) and o["kind"] in ("number", "string")
            has_range = "min" in o and "max" in o
            if leads:
                meaning = html.escape(label) + " " + default(o, plain=True)
                meaning = sentence(meaning) if help_text or has_range else meaning
            else:
                meaning = html.escape(sentence(label) if help_text or has_range else label)
            if help_text:
                help_text = sentence(help_text) if has_range else help_text
                meaning += f'{gap}<span class="opt-help">{html.escape(help_text)}</span>'
            if o.get("choices"):
                meaning += '<span class="opt-choices">' + " · ".join(f"{code(c['value'])} {html.escape(t(c['label']))}" for c in o["choices"]) + "</span>"
            if has_range:
                meaning += f'{gap}<span class="opt-range">{html.escape(U["options_range"].format(min=o["min"], max=o["max"]))}</span>'
            rows.append(f"<tr><td>{code(o['key'])}</td><td>{default(o)}</td><td>{meaning}</td></tr>")
        table = (
            f'<div class="table-wrap"><table><thead><tr><th>{html.escape(U["options_option"])}</th><th>{html.escape(U["options_default"])}</th>'
            f'<th>{html.escape(U["options_meaning"])}</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
            if rows else f'<p class="opt-none">{html.escape(U["options_none"])}</p>'
        )
        parts.append(
            f'<h2 id="{fid}">{title} <code class="opt-name">{f["name"]}</code></h2>\n'
            f'<p class="opt-flags">{"".join(flags)}</p>\n<p>{html.escape(t(f["summary"]))}</p>\n{table}'
        )
    return "\n".join(parts)


def decision_groups(manifest, lang, D, questions, D_en):
    ml = MANIFEST_LANG[lang]
    features = {f["name"]: f for f in manifest["features"]}
    groups = []
    for key, names in manifest["groups"].items():
        points = []
        for d in manifest["decisions"]:
            if d["group"] != key:
                continue
            flag = None
            if not features[d["feature"]].get("defaultEnabled", True):
                flag = D["page"]["default_off"]
            elif d["id"] == "tool.admission.test-log":
                flag = D["page"]["needs_option"]
            title = d["title"].get(ml) or d["title"]["en"]
            question = questions.get(d["id"], "")
            if not question:
                warn(f"{lang}: the README has no question for {d['id']}")
            example = D["examples"].get(d["id"]) or D_en["examples"].get(d["id"])
            if not D["examples"].get(d["id"]):
                warn(f"{lang}: no example for {d['id']} in content/decisions.{lang}.json" + ("" if example else ", nor in English"))
            points.append({
                "id": d["id"], "title": html.escape(title, quote=False), "summary": html.escape(d["summary"].get(ml) or d["summary"]["en"], quote=False),
                "question": question, "feature": d["feature"], "flag": flag,
                "ex": {k: md.renderInline(v) for k, v in example.items()} if example else None,
                "search": " ".join([title, d["title"]["en"], d["id"], re.sub(r"<[^>]+>", "", question)]).lower(),
            })
        groups.append({"key": key, "name": names.get(ml) or names["en"], "blurb": D["page"]["groups"][key], "points": points})
    return groups


# ---- Changelog ----

def changelog_entries(L, ctx, releases, sections, agents):
    """One entry per release, newest first. A language's own translation when it has one (an entry may cover several
    releases), else the release's section of CHANGELOG.md, in English."""
    lang = L["lang"]
    P = L["changelog"]
    translated = {}
    for E in P.get("entries", []):
        for number in E.get("covers") or [E["version"].lstrip("v")]:
            translated[number] = E
    entries, used = [], set()
    for R in releases:
        number = R["number"]
        anchor = re.sub(r"[^\w]+", "-", R["tag"]).strip("-")
        agent = f"mu-agent {agents[number]}" if agents.get(number) else ""
        E = translated.get(number)
        if E is not None:
            if id(E) in used:
                continue
            used.add(id(E))
            # A translation keeps the anchor it has always had: "v0.1.0 – v0.1.2" is #v0-1-0.
            own = re.sub(r"[^\w]+", "-", E["version"].split(" ")[0]).strip("-")
            entries.append(dict(E, id=own, agent=E.get("agent") or agent, href=R["url"], html=None, lang=None))
        elif number in sections:
            S = sections[number]
            entries.append({
                "id": anchor, "version": R["tag"], "date": S["date"] or R["date"], "agent": agent, "href": R["url"],
                "items": [], "html": render_repo_markdown(S["body"], "CHANGELOG.md", ctx).replace("<h3>", '<h3 class="release-kind">'),
                "lang": None if lang == "en" else "en",
            })
        else:
            warn(f"{lang}: {R['tag']} is released, but CHANGELOG.md has no [{number}] section")
    return entries


# ---- Build ----

def check_anchors(outdir, written):
    """Every same-site link with a fragment points at an id that exists on its page."""
    ids, problems = {}, []
    for path, _ in written:
        text = (outdir / path).read_text()
        ids[str(path)] = set(re.findall(r'\sid="([^"]+)"', text))
    for path, _ in written:
        text = (outdir / path).read_text()
        for href in re.findall(r'href="([^"#:]*)#([^"]+)"', text):
            target, frag = href
            if target.startswith(("http", "mailto")):
                continue
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(str(path)), target or posixpath.basename(str(path))))
            if target and not target.endswith(".html"):
                resolved = posixpath.join(posixpath.normpath(posixpath.join(posixpath.dirname(str(path)), target)), "index.html")
            if resolved.startswith("./"):
                resolved = resolved[2:]
            if resolved in ids and html.unescape(frag) not in ids[resolved]:
                problems.append(f"{path}: #{frag} → {resolved}")
    return sorted(set(problems))


def check_facts(outdir, locales, modes, manifest):
    """What the pages say against the product: the permission modes by the app's names, and the decision points that
    are off by default named where the configuration is explained."""
    features = {f["name"]: f for f in manifest["features"]}
    off = [d["id"] for d in manifest["decisions"] if not features[d["feature"]].get("defaultEnabled", True)]
    for L in locales:
        lang = L["lang"]
        permissions = (outdir / L["path"] / "docs/permissions/index.html").read_text()
        for key, name in modes[lang].items():
            if html.escape(name, quote=False) not in permissions:
                warn(f"{lang}: the permissions page never names the {key} mode as the app does ({name!r})")
        configuration = (outdir / L["path"] / "docs/configuration/index.html").read_text()
        for pid in off:
            if f"<code>{pid}</code>" not in configuration:
                warn(f"{lang}: {pid} is off by default, and the configuration page doesn't say so")


def main():
    parser = argparse.ArgumentParser(description="Build usemu.dev.")
    parser.add_argument("outdir")
    parser.add_argument("--repo", default=os.environ.get("MU_REPO") or str(here.parent), help="a checkout of qybaihe/mu")
    args = parser.parse_args()
    repo = Path(args.repo).expanduser().resolve()
    if not (repo / "packages/kyrn-judge/manifest.json").exists():
        raise SystemExit(f"{repo} is not a checkout of qybaihe/mu (no packages/kyrn-judge/manifest.json); pass --repo")
    outdir = Path(args.outdir).expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((repo / "packages/kyrn-judge/manifest.json").read_text())
    features = {f["name"]: f for f in manifest["features"]}
    facts = {
        "points": len(manifest["decisions"]),
        "points_active": sum(1 for d in manifest["decisions"] if features[d["feature"]].get("defaultEnabled", True)),
    }
    locales = [fill(json.loads((here / "i18n" / f"{lang}.json").read_text()), facts) for lang in LOCALES]
    en = locales[LOCALES.index("en")]
    recordings = {name: load_recording(name) for name in ("zh", "en")}
    sections = changelog_sections(repo)
    releases = mu_releases()
    agents = {R["number"]: bundled_agent(R, repo) for R in releases}
    latest = releases[0]
    if not agents[latest["number"]]:
        warn(f"no mu-agent version found for {latest['tag']}; the banner leaves it out")
    modes = {L["lang"]: mode_labels(repo, L["lang"]) for L in locales}

    css = "".join((here / "static" / name).read_text() for name in ("site.base.css", "site.extra.css", "site.pages.css"))
    js = (here / "static" / "site.js").read_text()
    version = hashlib.sha1((css + js).encode()).hexdigest()[:8]
    assets = outdir / "assets"
    (assets / "readme").mkdir(parents=True, exist_ok=True)
    (assets / "site.css").write_text(css)
    (assets / "site.js").write_text(js)
    for name in README_ASSETS:
        if name.endswith(".svg"):
            shutil.copy(repo / "docs/readme" / name, assets / "readme" / name)
    for name in ("test-log-folding.mp4", "test-log-folding-poster.webp"):
        shutil.copy(here / "assets" / name, assets / "readme" / name)
    for name in SITE_ASSETS:
        shutil.copy(here / "assets" / name, assets / name)

    stars = star_count()
    release = {
        "tag": latest["tag"], "number": latest["number"], "agent": agents.get(latest["number"]),
        "downloads": {suffix: latest["assets"].get(f"mu-{latest['number']}-{suffix}")
                      or f"{REPO}/releases/download/{latest['tag']}/mu-{latest['number']}-{suffix}" for suffix in DOWNLOADS},
    }
    env = Environment(loader=FileSystemLoader(here / "templates"), undefined=StrictUndefined, autoescape=False, keep_trailing_newline=True)
    written, fallbacks = [], []

    for L in locales:
        lang = L["lang"]
        (_, points_body), (measured_heading, measured_body) = readme_parts(repo, lang)
        D = fill(load_json("decisions", lang), facts)
        D_en = fill(load_json("decisions", "en"), facts)
        U = fill(load_json("docs-ui", lang), facts)
        docs = {}
        for slug, section in DOCS:
            front, body = load_doc(lang, slug)
            if not (here / "content" / "docs" / lang / f"{slug}.md").exists():
                fallbacks.append(f"{lang}/{slug}")
            docs[slug] = {"slug": slug, "section": U["sections"][section], "section_key": section, "title": fill(front["title"], facts),
                          "summary": fill(front["summary"], facts), "source": fill(body, facts), "page": PAGES[f"docs/{slug}"]}
        sidebar = [{"title": U["sections"][s], "entries": [docs[slug] for slug, sec in DOCS if sec == s]} for s in ("start", "use", "ref")]
        # The banner: the newest release, with a line on what it brings when this language has one.
        headline = L["changelog"].get("headlines", {}).get(latest["tag"])
        announce = (L["ui"]["announce"] if headline else L["ui"]["announce_plain"]).format(tag=latest["tag"], headline=headline)
        if release["agent"]:
            announce += L["ui"]["announce_agent"].format(agent=release["agent"])
        banner = {"text": announce, "anchor": re.sub(r"[^\w]+", "-", latest["tag"]).strip("-")}
        # The root page is the Chinese home page, and link previews (Reddit, X, Slack) read it without running its
        # script: its description and preview are English.
        root = lang == "zh-CN"

        for key, page in PAGES.items():
            ctx = Page(L, page)
            preview = root and key == "home"
            values = {
                "L": L, "page": page, "pages": PAGES, "locales": locales, "site": SITE, "root": ctx.root, "version": version,
                "url": ctx.url, "abs": lambda X, P: SITE + X["path"] + P["path"],
                "lang_paths": {X["lang"]: X["path"] for X in locales},
                "stars_text": format_stars(stars), "js_strings": {"copied": L["ui"]["copied"]},
                "readme_url": REPO if lang == "en" else f"{REPO}/blob/main/{readme_repo_path(lang)}",
                "banner": banner, "meta": en["meta"] if preview else L["meta"],
                "og_locale": OG_LOCALE["en" if preview else lang],
            }
            if key == "home":
                values.update(rec=recordings[L["recording"]], release=release)
                template = "home.html"
            elif key == "changelog":
                P = dict(L["changelog"])
                P["entries"] = changelog_entries(L, ctx, releases, sections, agents)
                values.update(P=P)
                template = "changelog.html"
            elif key == "decisions":
                groups = decision_groups(manifest, lang, D, readme_questions(points_body), D_en)
                ml = MANIFEST_LANG[lang]
                values.update(
                    D=D["page"], groups=groups, total=sum(len(g["points"]) for g in groups),
                    modes=[{"value": m["value"], "label": m["label"].get(ml) or m["label"]["en"], "help": m["help"].get(ml) or m["help"]["en"]} for m in manifest["modes"]],
                    demo=D["examples"]["input.preflight"], rec=recordings[L["recording"]],
                    measured=f'<h2 id="measured-results">{html.escape(measured_heading)}</h2>\n' + render_repo_markdown(measured_body, readme_repo_path(lang), ctx),
                    docs_options=PAGES["docs/options"], docs_judges=PAGES["docs/judges"],
                )
                template = "decisions.html"
            elif key == "docs":
                values.update(U=U, sidebar=sidebar)
                template = "docs_index.html"
            else:
                slug = key.split("/", 1)[1]
                doc = dict(docs[slug])
                toc = []
                body = render_doc(doc["source"], ctx, toc)
                if slug == "options":
                    body += "\n" + render_options(manifest, lang, ctx, U, toc)
                order = [s for s, _ in DOCS]
                i = order.index(slug)
                doc.update(body=body, prev=docs[order[i - 1]] if i > 0 else None, next=docs[order[i + 1]] if i + 1 < len(order) else None)
                values.update(U=U, sidebar=sidebar, doc=doc, toc=toc)
                template = "doc.html"
            out = env.get_template(template).render(**values)
            if "<built-in method" in out or "<bound method" in out:
                raise SystemExit(f"{lang} {key}: a template name hit a dict method (use L.x['name'])")
            unknown = re.findall(r"\{points[a-z_]*\}", out)
            if unknown:
                raise SystemExit(f"{lang} {key}: {unknown[0]} is not a known fact")
            target = outdir / L["path"] / page["path"] / "index.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(out)
            written.append((target.relative_to(outdir), len(out.encode())))

    urls = [SITE + X["path"] + P["path"] for X in locales for P in PAGES.values()]
    (outdir / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls) + "</urlset>\n"
    )
    (outdir / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE}sitemap.xml\n")
    # A top-level 404 prevents Pages from treating this multi-page site as an SPA.
    (outdir / "404.html").write_text(env.get_template("not_found.html").render(locales=locales, version=version))
    for name in ("_headers", "_redirects"):
        shutil.copy(here / "static" / name, outdir / name)
    check_facts(outdir, locales, modes, manifest)
    print(f"{len(written)} pages, {sum(s for _, s in written) // 1024} KB; {facts['points']} decision points, {facts['points_active']} active from the start;"
          f" newest release {latest['tag']} (mu-agent {release['agent']}); stars {stars}; version {version}")
    if fallbacks:
        print(f"English fallback for {len(fallbacks)} docs pages:", ", ".join(sorted({f.split('/')[0] for f in fallbacks})))
    problems = check_anchors(outdir, written)
    print("anchors:", "all found" if not problems else f"{len(problems)} missing")
    for p in problems[:40]:
        print("  ", p)
    prefix = "::warning::" if os.environ.get("GITHUB_ACTIONS") else "warning: "
    for w in dict.fromkeys(WARNINGS):
        print(prefix + w)


if __name__ == "__main__":
    main()
