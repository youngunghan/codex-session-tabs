"""One-request JSONL bridge for the public openai-codex Python SDK.

The extension starts a fresh process for each operation. Its AsyncCodex context is
closed before the process exits, so browsing history never retains a writer lock.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
from typing import Any

from openai_codex import ApprovalMode, AsyncCodex, Sandbox

REQUEST_ID = ""
MAX_TOOL_TEXT = 32_768
MAX_TEXT_CHUNK = 4_096
MAX_JSON_CHUNK_BYTES = 64 * 1_024


def abort_on_parent_eof() -> None:
    """Stop SDK descendants if the extension host disappears mid-turn."""
    own_pid = os.getpid()
    if os.name == "nt":
        subprocess.Popen(["taskkill", "/PID", str(own_pid), "/T", "/F"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        os._exit(1)
    try:
        rows = subprocess.check_output(["ps", "-A", "-o", "pid=,ppid="],
                                       text=True, timeout=1).splitlines()
        children: dict[int, list[int]] = {}
        for row in rows:
            columns = row.split()
            if len(columns) != 2 or not all(part.isdecimal() for part in columns):
                continue
            pid, parent = map(int, columns)
            children.setdefault(parent, []).append(pid)
        queue = [own_pid]
        found: list[int] = []
        for pid in queue:
            for child in children.get(pid, []):
                if child not in queue:
                    queue.append(child)
                    found.append(child)
        for pid in found:
            try:
                os.kill(pid, signal.SIGSTOP)
            except ProcessLookupError:
                pass
        for pid in reversed(found):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except Exception:
        pass  # The helper still terminates even if process enumeration fails.
    try:
        if os.getpgrp() == own_pid:
            os.killpg(own_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os._exit(1)


def clipped(value: Any, limit: int) -> str:
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "\n[output truncated]"


def emit(kind: str, **fields: Any) -> None:
    print(json.dumps({"requestId": REQUEST_ID, "kind": kind, **fields}, ensure_ascii=False), flush=True)


def settings(request: dict[str, Any]) -> tuple[Sandbox, ApprovalMode]:
    mode = request.get("mode", "read_only")
    if mode == "workspace_write":
        return Sandbox.workspace_write, ApprovalMode.deny_all
    if mode == "read_only":
        return Sandbox.read_only, ApprovalMode.deny_all
    raise ValueError("Unsupported sandbox mode")


def thread_row(thread: Any) -> dict[str, Any]:
    return {
        "id": thread.id,
        "name": clipped(thread.name or "", 200),
        "preview": clipped(thread.preview or "", 500),
        "cwd": clipped(thread.cwd.root or "", 4_096),
        "updatedAt": thread.updated_at,
    }


def item_row(item: Any) -> dict[str, str] | None:
    item = item.root
    kind = item.type
    if kind == "userMessage":
        text = "\n".join(content.root.text for content in item.content if content.root.type == "text")
        return {"role": "user", "text": text} if text else None
    if kind == "agentMessage":
        return {"role": "assistant", "text": item.text}
    if kind == "commandExecution":
        return {"role": "tool", "text": clipped(f"$ {item.command}\n{item.aggregated_output or ''}", MAX_TOOL_TEXT)}
    if kind == "fileChange":
        changes = [getattr(change, "path", "") for change in item.changes]
        return {"role": "tool", "text": clipped("Files changed: " + ", ".join(str(value) for value in changes), MAX_TOOL_TEXT)}
    return None


def history_rows(thread: Any):
    for turn in thread.turns:
        for item in turn.items:
            row = item_row(item)
            if row:
                yield row


def emit_history(thread: Any) -> None:
    batch: list[dict[str, Any]] = []
    size = 0
    for row in history_rows(thread):
        text = row["text"]
        for offset in range(0, max(1, len(text)), MAX_TEXT_CHUNK):
            part = {"role": row["role"], "text": text[offset:offset + MAX_TEXT_CHUNK], "continuation": offset > 0}
            part_size = len(json.dumps(part, ensure_ascii=False).encode("utf-8"))
            if batch and size + part_size > MAX_JSON_CHUNK_BYTES:
                emit("loadedChunk", messages=batch)
                batch, size = [], 0
            batch.append(part)
            size += part_size
    if batch:
        emit("loadedChunk", messages=batch)


async def resume(codex: AsyncCodex, request: dict[str, Any]) -> Any:
    sandbox, approval = settings(request)
    kwargs = {"sandbox": sandbox, "approval_mode": approval, "cwd": request.get("cwd")}
    try:
        return await codex.thread_resume(request["threadId"], include_turns=True, **kwargs)
    except Exception as error:
        # The SDK runtime may reject turn listing for a named, zero-turn thread.
        if "list_turns is not supported yet" not in str(error):
            raise
        return await codex.thread_resume(request["threadId"], include_turns=False, **kwargs)


async def read_thread(thread: Any) -> Any:
    try:
        return (await thread.read(include_turns=True)).thread
    except Exception as error:
        if "list_turns is not supported yet" not in str(error):
            raise
        return (await thread.read(include_turns=False)).thread


def watch_stop(turn: Any) -> asyncio.Event:
    # A daemon reader avoids blocking asyncio.run's executor shutdown when the
    # extension keeps stdin open while a completed turn exits.
    loop = asyncio.get_running_loop()
    done = asyncio.Event()

    async def interrupt() -> None:
        if done.is_set():
            emit("stopIgnored")
            return
        emit("stopping")
        deadline = loop.time() + 5
        while not done.is_set():
            try:
                await turn.interrupt()
                return
            except Exception as error:
                if "no active turn to interrupt" not in str(error).lower():
                    emit("stopError", message=str(error))
                    return
                if loop.time() >= deadline:
                    emit("stopError", message="Turn did not become interruptible within five seconds.")
                    return
                try:
                    await asyncio.wait_for(done.wait(), min(0.1, deadline - loop.time()))
                except asyncio.TimeoutError:
                    pass
        emit("stopIgnored")

    def reader() -> None:
        stop_requested = False
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("op") == "stop" and not stop_requested:
                stop_requested = True
                try:
                    loop.call_soon_threadsafe(lambda: asyncio.create_task(interrupt()))
                except RuntimeError:
                    pass  # The turn finished as the stop request arrived.
        if not done.is_set():
            abort_on_parent_eof()

    threading.Thread(target=reader, daemon=True).start()
    return done


async def send(codex: AsyncCodex, request: dict[str, Any]) -> None:
    sandbox, approval = settings(request)
    if request.get("threadId"):
        thread = await resume(codex, request)
    else:
        thread = await codex.thread_start(
            cwd=request.get("cwd"), sandbox=sandbox, approval_mode=approval,
        )
        # Emit before any later step can fail. The extension persists this ID.
        emit("thread", threadId=thread.id)
        # A named zero-turn thread is resumable even if thread_list omits it.
        await thread.set_name(request["text"].strip().splitlines()[0][:60] or "Codex chat")
    turn = await thread.turn(
        request["text"], cwd=request.get("cwd"), sandbox=sandbox, approval_mode=approval,
    )
    emit("turn", turnId=turn.id)
    done = watch_stop(turn)
    try:
        async for event in turn.stream():
            if event.method == "item/agentMessage/delta":
                delta = event.payload.delta
                for offset in range(0, len(delta), MAX_TEXT_CHUNK):
                    emit("delta", itemId=event.payload.item_id, text=delta[offset:offset + MAX_TEXT_CHUNK])
            elif event.method == "item/completed":
                row = item_row(event.payload.item)
                if row and row["role"] != "user":
                    emit("item", itemId=event.payload.item.root.id, **row)
            elif event.method == "turn/completed":
                emit("completed", status=event.payload.turn.status.value)
    finally:
        done.set()


async def run(request: dict[str, Any]) -> None:
    op = request.get("op")
    async with AsyncCodex() as codex:
        if op == "list":
            page = await codex.thread_list(limit=50, cursor=request.get("cursor"))
            emit("list", threads=[thread_row(item) for item in page.data], nextCursor=page.next_cursor)
        elif op == "load":
            thread = await resume(codex, request)
            data = await read_thread(thread)
            emit_history(data)
            emit("loaded", thread=thread_row(data))
        elif op == "rename":
            thread = await resume(codex, request)
            await thread.set_name(request["name"])
            emit("renamed", threadId=thread.id, name=request["name"])
        elif op == "send":
            await send(codex, request)
        else:
            raise ValueError("Unsupported operation")


async def main() -> None:
    global REQUEST_ID
    try:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            raise ValueError("Missing request")
        request = json.loads(line)
        REQUEST_ID = request.get("requestId", "")
        if not isinstance(REQUEST_ID, str) or not REQUEST_ID:
            raise ValueError("Missing request ID")
        await run(request)
    except Exception as error:
        message = str(error) or type(error).__name__
        lower = message.lower()
        code = "BUSY" if any(word in lower for word in ("already in use", "locked", "busy", "active owner")) else "ERROR"
        emit("error", code=code, message=message)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
