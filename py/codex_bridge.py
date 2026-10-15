"""One-request JSONL bridge for the public openai-codex Python SDK.

The extension starts a fresh process for each operation. Its AsyncCodex context is
closed before the process exits, so browsing history never retains a writer lock.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
from typing import Any

from openai_codex import ApprovalMode, AsyncCodex, Sandbox

REQUEST_ID = ""


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
        "name": thread.name,
        "preview": thread.preview,
        "cwd": thread.cwd.root,
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
        return {"role": "tool", "text": f"$ {item.command}\n{item.aggregated_output or ''}"}
    if kind == "fileChange":
        changes = [getattr(change, "path", "") for change in item.changes]
        return {"role": "tool", "text": "Files changed: " + ", ".join(str(value) for value in changes)}
    return None


def history_rows(thread: Any) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for turn in thread.turns:
        for item in turn.items:
            row = item_row(item)
            if row:
                rows.append(row)
    return rows


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


def watch_stop(turn: Any) -> None:
    # A daemon reader avoids blocking asyncio.run's executor shutdown when the
    # extension keeps stdin open while a completed turn exits.
    loop = asyncio.get_running_loop()

    async def interrupt() -> None:
        try:
            await turn.interrupt()
            emit("stopping")
        except Exception as error:
            if "no active turn to interrupt" in str(error).lower():
                emit("stopIgnored")
            else:
                emit("stopError", message=str(error))

    def reader() -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("op") == "stop":
                try:
                    loop.call_soon_threadsafe(lambda: asyncio.create_task(interrupt()))
                except RuntimeError:
                    pass  # The turn finished as the stop request arrived.
                return

    threading.Thread(target=reader, daemon=True).start()


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
    watch_stop(turn)
    async for event in turn.stream():
        if event.method == "item/agentMessage/delta":
            emit("delta", itemId=event.payload.item_id, text=event.payload.delta)
        elif event.method == "item/completed":
            row = item_row(event.payload.item)
            if row and row["role"] != "user":
                emit("item", itemId=event.payload.item.root.id, **row)
        elif event.method == "turn/completed":
            emit("completed", status=event.payload.turn.status.value)


async def run(request: dict[str, Any]) -> None:
    op = request.get("op")
    async with AsyncCodex() as codex:
        if op == "list":
            page = await codex.thread_list(limit=50, cursor=request.get("cursor"))
            emit("list", threads=[thread_row(item) for item in page.data], nextCursor=page.next_cursor)
        elif op == "load":
            thread = await resume(codex, request)
            data = await read_thread(thread)
            emit("loaded", thread=thread_row(data), messages=history_rows(data))
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
