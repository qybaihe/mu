"""A scripted coding model for the usemu.dev replay: an OpenAI-compatible chat completions endpoint.

Each main-agent request gets the next step of the script, picked by how many tool results the
conversation already has. Any other request (one without tools) gets a short plain answer.

usage: mockmodel.py [port] [log file]: the log gets one line per request (its size, tools and step),
never its headers or messages.
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = Path(sys.argv[2]) if len(sys.argv) > 2 else None

OLD = "  m: 1000,\n"
NEW = "  m: 60_000,\n"

STEPS = {
    "en": [
        ("I'll run the tests first, then look at how the timeout is parsed.", "bash", {"command": "npm test"}),
        (
            "One failure: parseDuration('1h30m') returns 3,630,000 ms instead of 5,400,000, so the 30 minutes "
            "count as 30 seconds. That's the timeout the worker gets. Let me read the parser.",
            "read",
            {"path": "src/config/duration.js"},
        ),
        (
            "Found it. In the unit table, m is 1,000 ms, the same as a second. A minute is 60,000 ms.",
            "edit",
            {"path": "src/config/duration.js", "edits": [{"oldText": OLD, "newText": NEW}]},
        ),
        ("Running the tests again.", "bash", {"command": "npm test"}),
        (
            "Fixed. A minute was defined as 1,000 ms, so 1h30m was read as one hour and 30 seconds, and the "
            "worker aborted the job then.\n\n"
            "- src/config/duration.js: the m unit is now 60_000.\n"
            "- npm test: all 13 tests pass.\n\n"
            'Backoffs in minutes were read the same way: the exports queue (backoff: "2m") retried after '
            "2 seconds, and now waits 2 minutes.",
            None,
            None,
        ),
    ],
    "zh": [
        ("先跑一遍测试，再看超时是怎么解析的。", "bash", {"command": "npm test"}),
        (
            "有一个失败：parseDuration('1h30m') 返回 3,630,000 毫秒，而不是 5,400,000，30 分钟被当成了 30 秒。"
            "worker 拿到的就是这个超时。我看一下解析器。",
            "read",
            {"path": "src/config/duration.js"},
        ),
        (
            "找到了。单位表里 m 是 1,000 毫秒，和秒一样。一分钟应该是 60,000 毫秒。",
            "edit",
            {"path": "src/config/duration.js", "edits": [{"oldText": OLD, "newText": NEW}]},
        ),
        ("再跑一遍测试。", "bash", {"command": "npm test"}),
        (
            "修好了。一分钟被定义成了 1,000 毫秒，所以 1h30m 被读成一小时零 30 秒，worker 到点就中止了任务。\n\n"
            "- src/config/duration.js：m 改为 60_000。\n"
            "- npm test：13 个测试全部通过。\n\n"
            '以分钟为单位的 backoff 也受了同样的影响：exports 队列（backoff: "2m"）原来 2 秒后就重试，现在会等 2 分钟。',
            None,
            None,
        ),
    ],
}


def chunks(text, lang):
    """Pieces as a model streams them: a few words, or a few characters of Chinese."""
    if lang == "zh":
        return [text[i : i + 3] for i in range(0, len(text), 3)]
    return re.findall(r"\S+\s*|\s+", text)


def user_text(messages):
    for m in messages:
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            if c:
                return c
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": "mimo-v2.6-pro", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        req = json.loads(raw or b"{}")
        messages = req.get("messages", [])
        tools = [t.get("function", {}).get("name") for t in req.get("tools", [])]
        lang = "zh" if re.search(r"[\u4e00-\u9fff]", user_text(messages)) else "en"
        done = sum(1 for m in messages if m.get("role") == "tool")
        main = {"bash", "read", "edit"} <= set(tools)
        if LOG:
            with LOG.open("a") as f:
                f.write(json.dumps({"t": time.time(), "path": self.path, "model": req.get("model"), "tools": tools,
                                "messages": len(messages), "tool_results": done, "lang": lang, "main": main,
                                "bytes": len(raw)}) + "\n")
        if main and done < len(STEPS[lang]):
            text, tool, args = STEPS[lang][done]
        else:
            text, tool, args = ("OK.", None, None)
        prompt_tokens = len(raw) // 4
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        cid = f"chatcmpl-{int(time.time() * 1000)}"

        def send(delta, finish=None, usage=None):
            obj = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": req.get("model"),
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage is not None:
                obj["usage"] = usage
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        time.sleep(0.35 if main else 0.05)
        send({"role": "assistant", "content": ""})
        out = 0
        for piece in chunks(text, lang):
            send({"content": piece})
            out += max(1, len(piece) // 3)
            time.sleep(0.03 if main else 0)
        finish = "stop"
        if tool:
            time.sleep(0.15)
            send({"tool_calls": [{"index": 0, "id": f"call_{done}", "type": "function",
                                  "function": {"name": tool, "arguments": json.dumps(args, ensure_ascii=False)}}]})
            out += 30
            finish = "tool_calls"
        send({}, finish=finish)
        send({}, usage={"prompt_tokens": prompt_tokens, "completion_tokens": out, "total_tokens": prompt_tokens + out})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
