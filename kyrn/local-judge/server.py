#!/usr/bin/env python3
"""mu local judge sidecar.

Serves a Laya Core ML checkpoint (https://github.com/mizorewww/laya-coreml) over
the same wire contract as the AI Gateway `evaluation-model` endpoint, so the
mu kernel can swap the hosted judge model for a local one without translating anything:

    POST /evaluate  {"state": ..., "questions": {id: {type, instructions, criteria?}}}
                 -> {"answers": {...}, "usage": {...}, "warnings": [...], "providerMetadata": {"laya": {...}}}
    GET  /health -> {"status": "ok" | "warming", ...}

Question types use the gateway names: `boolean` (Laya calls it `noul`), `choice`, `score`.

The server binds to loopback only, never logs state or question text, and keeps
the model behind one lock because a Core ML model is not safe to call concurrently.
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 47823
MAX_BODY_BYTES = 1024 * 1024
# Every request is padded to at least this many tokens; by default (None) to the checkpoint's whole window, so that
# after warm-up the input length never changes. A change of length is what crashed the sidecar: Core ML re-specializes
# the GPU program from its compiled copy of the model in ~/Library/Caches/<process>/com.apple.e5rt.e5bundlecache,
# which it marks APFS-purgeable, and macOS deletes those files whenever the disk runs low. The next change of length
# then recompiles the model (3-36 s, 644 MB written again) or, when the purge lands mid-load, aborts the process with
# "MPSGraphTensorData.mm: failed assertion `shape.count = 0 != strides.count = 2'". Measured on an M6 under load:
# 1024 tokens cost ~34 ms a question at a steady length against ~23-32 ms for 384-768, while a change of length
# cost 0.4-1.1 s at p50 and up to 18 s at p90. A lower floor (MU_LOCAL_JUDGE_MIN_LENGTH=256) is faster for short
# requests and brings the changes of length back.
DEFAULT_MIN_LENGTH = None
DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "models" / "laya-multilingual-coreml"


class BadRequest(ValueError):
    pass


def setting(name, default):
    """`MU_<name>`, or the `KYRN_<name>` spelling from before the rename."""
    return os.environ.get(f"MU_{name}") or os.environ.get(f"KYRN_{name}") or default


def _text(value):
    """Laya serializes non-string instructions with ASCII escapes, which mangles CJK. Do it here instead."""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def to_laya_question(question_id, question):
    if not isinstance(question, dict):
        raise BadRequest(f'Question "{question_id}" must be an object')
    kind = question.get("type")
    if "instructions" not in question:
        raise BadRequest(f'Question "{question_id}" is missing instructions')
    instructions = _text(question["instructions"])
    criteria = question.get("criteria")

    if kind == "boolean":
        out = {"type": "noul", "instructions": instructions}
        if isinstance(criteria, dict):
            kept = {key: criteria[key] for key in ("false", "true") if criteria.get(key) not in (None, "")}
            if kept:
                out["criteria"] = kept
        return out
    if kind == "choice":
        if not isinstance(criteria, dict) or not criteria:
            raise BadRequest(f'Choice question "{question_id}" needs a non-empty criteria object')
        return {"type": "choice", "instructions": instructions, "criteria": dict(criteria)}
    if kind == "score":
        if not isinstance(criteria, list) or len(criteria) < 2:
            raise BadRequest(f'Score question "{question_id}" needs at least two levels')
        return {
            "type": "score",
            "instructions": instructions,
            "criteria": ["" if level is None else level for level in criteria],
        }
    raise BadRequest(f'Question "{question_id}" has unknown type {kind!r}; expected boolean, choice or score')


def from_laya_answer(answer):
    kind = answer["type"]
    if kind == "noul":
        return {"type": "boolean", "probability": answer["noul"]}
    if kind == "choice":
        return {"type": "choice", "choice": answer["choice"], "probabilities": answer["probabilities"]}
    return {"type": "score", "score": answer["score"], "probabilities": answer["probabilities"]}


class LocalJudge:
    def __init__(self, model_dir, compute_units=None, min_length=DEFAULT_MIN_LENGTH):
        import laya_coreml as laya

        self.model_dir = Path(model_dir)
        started = time.perf_counter()
        self.agent = laya.load(str(self.model_dir), local_files_only=True, compute_units=compute_units)
        self.load_seconds = time.perf_counter() - started
        self.lock = threading.Lock()
        self.warm = False
        self.requests = 0
        self.started_at = time.time()
        manifest = getattr(self.agent, "manifest", {})
        self.model_id = "laya:" + str(manifest.get("repository") or self.model_dir.name)
        self.shape = getattr(self.agent, "shape", {})
        if min_length is None:
            min_length = getattr(self.agent, "cfg", {}).get("max_len") or self.shape.get("max_length") or 0
        self.min_length = int(min_length)

    def uniform_shape(self, state, laya_questions):
        """Pad every question of a request to one input length.

        Core ML re-specializes the GPU program whenever the enumerated length
        changes (0.3-1 s, against ~30 ms for a steady shape), reading the
        compiled model back from a cache macOS may have purged (see
        DEFAULT_MIN_LENGTH). The questions of one request differ in length
        because their options do, so one bucket per request removes the
        changes within it; the floor keeps every request in the same bucket.
        """
        lengths = self.agent.shape.get("lengths")
        if not lengths:
            return self.agent.shape
        items, _internal = self.agent.prepare(state, laya_questions)
        longest = max(max(len(item["ids"]) for item in items), self.min_length)
        target = next((n for n in lengths if n >= longest), lengths[-1])
        return dict(self.agent.shape, lengths=[target])

    def diagnostics(self, state, laya_questions):
        """Report what the token budget silently cut. Never raises."""
        warnings = []
        try:
            from laya_coreml.common import build_prefix, render_options, serialize_state

            tok, cfg = self.agent.tok, self.agent.cfg
            max_len, head_max_len = cfg.get("max_len", 512), cfg.get("head_max_len", 192)
            state_tokens = len(tok(serialize_state(state).replace(tok.mask_token, " "))["input_ids"])
            for question_id, definition in laya_questions.items():
                q = self.agent._to_internal(definition)
                prefix, _markers = build_prefix(tok, q, head_max_len)
                full_head = len(tok("%s question: %s" % (q["t"], q["ins"]))["input_ids"])
                full_options = sum(1 + len(tok(" " + option)["input_ids"]) for option in render_options(q))
                full_prefix = 1 + full_head + 1 + full_options + 1
                if len(prefix) < full_prefix:
                    warnings.append(
                        {
                            "type": "question_truncated",
                            "questionId": question_id,
                            "message": f"question and options need {full_prefix} tokens, {len(prefix)} were kept",
                        }
                    )
                room = max(0, max_len - len(prefix) - 1)
                if state_tokens > room:
                    warnings.append(
                        {
                            "type": "state_truncated",
                            "questionId": question_id,
                            "message": f"state has {state_tokens} tokens, only the first {room} were read",
                        }
                    )
        except Exception as error:  # noqa: BLE001 - diagnostics are best effort
            warnings.append({"type": "diagnostics_failed", "message": type(error).__name__})
        return warnings

    def evaluate(self, state, questions):
        if not isinstance(questions, dict) or not questions:
            raise BadRequest("questions must be a non-empty object keyed by question id")
        if not isinstance(state, (str, dict, list)):
            raise BadRequest("state must be a string, an object or an array")
        laya_questions = {qid: to_laya_question(qid, q) for qid, q in questions.items()}

        started = time.perf_counter()
        with self.lock:
            waited = time.perf_counter() - started
            original_shape = self.agent.shape
            try:
                self.agent.shape = self.uniform_shape(state, laya_questions)
                result = self.agent.predict(state, laya_questions)
            except ValueError as error:
                raise BadRequest(str(error)) from error
            finally:
                self.agent.shape = original_shape
            self.requests += 1
        elapsed = time.perf_counter() - started

        metadata = {
            qid: {"confidence": answer.get("confidence"), "actProbability": answer.get("action", {}).get("act_probability")}
            for qid, answer in result["answers"].items()
        }
        usage = result.get("usage", {})
        print(
            f"[{time.strftime('%H:%M:%S')}] evaluate questions={len(questions)} "
            f"tokens={usage.get('input_tokens', 0)} ms={elapsed * 1000:.0f} waited_ms={waited * 1000:.0f}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "answers": {qid: from_laya_answer(answer) for qid, answer in result["answers"].items()},
            "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": 0},
            "warnings": self.diagnostics(state, laya_questions),
            "providerMetadata": {"laya": {"model": self.model_id, "latencyMs": round(elapsed * 1000, 1), "answers": metadata}},
        }

    def warm_up(self):
        """Core ML compiles each enumerated input length on first use (seconds). Pay that before real traffic."""
        lengths = list(self.shape.get("lengths") or [self.shape.get("default_length", 128)])
        # Requests are padded to at least the floor's bucket, so no request uses a shorter one: warm only the lengths
        # traffic can reach, and finish on the floor's bucket, so the first request does not pay a shape switch.
        resting = next((n for n in lengths if n >= self.min_length), lengths[-1])
        lengths = [n for n in lengths if n > resting] + [resting]
        question = {"warm": {"type": "noul", "instructions": "Is this a warm-up request?"}}
        started = time.perf_counter()
        for length in lengths:
            # "a " is roughly one token; the prefix takes about 30, so this lands in the bucket for `length`.
            state = "a " * max(1, length - 40)
            try:
                with self.lock:
                    original_shape = self.agent.shape
                    self.agent.shape = dict(original_shape, lengths=[length])
                    try:
                        self.agent.predict(state, question)
                    finally:
                        self.agent.shape = original_shape
            except Exception as error:  # noqa: BLE001 - a failed warm-up only costs latency later
                print(f"warm-up for length {length} failed: {type(error).__name__}", file=sys.stderr, flush=True)
        self.warm = True
        print(f"warm-up finished in {time.perf_counter() - started:.1f}s ({len(lengths)} shapes)", file=sys.stderr, flush=True)

    def health(self):
        return {
            "status": "ok" if self.warm else "warming",
            "model": self.model_id,
            "computeUnits": getattr(self.agent, "compute_units", None),
            "maxLength": self.shape.get("max_length"),
            "maxOptions": self.shape.get("max_options"),
            "batchSize": self.shape.get("batch_size"),
            "requests": self.requests,
            "uptimeSeconds": round(time.time() - self.started_at),
            "pid": os.getpid(),
        }


def make_handler(judge):
    class Handler(BaseHTTPRequestHandler):
        server_version = "mu-local-judge/0.1"

        def log_message(self, *_args):
            pass

        def send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_failure(self, status, message):
            self.send_json(status, {"error": {"message": message}})

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, judge.health())
            else:
                self.send_failure(404, "Not found")

        def do_POST(self):
            if self.path != "/evaluate":
                return self.send_failure(404, "Not found")
            # Browsers always send Origin on cross-site POSTs; nothing legitimate calls this from a web page.
            if self.headers.get("Origin"):
                return self.send_failure(403, "Browser requests are not allowed")
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self.send_failure(415, "Content-Type must be application/json")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self.send_failure(400, "Invalid Content-Length")
            if length <= 0 or length > MAX_BODY_BYTES:
                return self.send_failure(413, f"Body must be between 1 and {MAX_BODY_BYTES} bytes")
            try:
                payload = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                return self.send_failure(400, "Body is not valid JSON")
            if not isinstance(payload, dict):
                return self.send_failure(400, "Body must be a JSON object")
            try:
                self.send_json(200, judge.evaluate(payload.get("state"), payload.get("questions")))
            except BadRequest as error:
                self.send_failure(400, str(error)[:300])
            except Exception as error:  # noqa: BLE001 - the kernel fails open on a 500
                print(f"evaluate failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                self.send_failure(500, f"Local judge failed: {type(error).__name__}")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="mu local judge sidecar (Laya on Core ML)")
    parser.add_argument("--model-dir", default=setting("LOCAL_JUDGE_MODEL", str(DEFAULT_MODEL_DIR)))
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=int(setting("LOCAL_JUDGE_PORT", DEFAULT_PORT)))
    parser.add_argument("--compute-units", choices=["all", "cpu", "cpu_gpu", "cpu_ne"])
    parser.add_argument("--no-warmup", action="store_true")
    parser.add_argument(
        "--min-length",
        type=int,
        default=setting("LOCAL_JUDGE_MIN_LENGTH", DEFAULT_MIN_LENGTH),
        help="Smallest input length to pad to. Default: the checkpoint's window, so the length never changes after "
        "warm-up; a change of length is slow and, when macOS has purged Core ML's cache, can crash the sidecar.",
    )
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("The local judge has no authentication and only binds to loopback")

    judge = LocalJudge(args.model_dir, compute_units=args.compute_units, min_length=args.min_length)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(judge))
    server.daemon_threads = True
    print(
        f"mu local judge: {judge.model_id} loaded in {judge.load_seconds:.1f}s, "
        f"listening on http://{args.host}:{args.port}",
        file=sys.stderr,
        flush=True,
    )
    if args.no_warmup:
        judge.warm = True
    else:
        threading.Thread(target=judge.warm_up, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
