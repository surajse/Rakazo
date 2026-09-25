"""Model connectors: chat completions with tool calling via litellm.

Supported provider kinds:
  - openai_compatible: any OpenAI-compatible endpoint (OpenAI, Groq, Together,
    OpenRouter, ...) configured with base_url + api_key + model.
  - anthropic: Anthropic API via api_key + model.
  - ollama: local Ollama via base_url (default http://localhost:11434) + model.

Returns a normalized dict: {"content": str|None, "tool_calls": [...]} and
optionally streams token deltas through an async on_token callback.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import litellm

litellm.suppress_debug_info = True


@dataclass
class ProviderConfig:
    kind: str
    model: str
    base_url: str | None = None
    api_key: str | None = None  # decrypted; None for keyless (e.g. local ollama)


def _litellm_model(cfg: ProviderConfig) -> str:
    name = cfg.model
    if "/" in name:
        return name
    if cfg.kind == "anthropic":
        return f"anthropic/{name}"
    if cfg.kind == "ollama":
        return f"ollama/{name}"
    return f"openai/{name}"  # openai_compatible


async def chat_completion(
    cfg: ProviderConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
    timeout: int = 180,
) -> dict[str, Any]:
    """Run a chat completion; normalized across providers.

    Raises the underlying provider error on failure so the agent loop can
    surface it as a run error.
    """
    kwargs: dict[str, Any] = {
        "model": _litellm_model(cfg),
        "messages": messages,
        "timeout": timeout,
        "stream": True,
    }
    if cfg.api_key:
        kwargs["api_key"] = cfg.api_key
    if cfg.base_url:
        kwargs["api_base"] = cfg.base_url
    elif cfg.kind == "ollama":
        kwargs["api_base"] = "http://localhost:11434"
    if tools:
        kwargs["tools"] = tools

    response = await litellm.acompletion(**kwargs)

    content_parts: list[str] = []
    tool_acc: dict[int, dict[str, Any]] = {}

    async for chunk in response:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        content = getattr(delta, "content", None)
        if content:
            content_parts.append(content)
            if on_token is not None:
                await on_token(content)
        for tc in getattr(delta, "tool_calls", None) or []:
            index = getattr(tc, "index", 0) or 0
            entry = tool_acc.setdefault(index, {"id": None, "name": "", "arguments": ""})
            if getattr(tc, "id", None):
                entry["id"] = tc.id
            func = getattr(tc, "function", None)
            if func is not None:
                if getattr(func, "name", None):
                    entry["name"] += func.name
                if getattr(func, "arguments", None):
                    entry["arguments"] += func.arguments

    tool_calls: list[dict[str, Any]] = []
    for entry in tool_acc.values():
        raw_args = entry["arguments"] or "{}"
        try:
            arguments = json.loads(raw_args)
        except json.JSONDecodeError:
            arguments = {"_raw": raw_args}
        tool_calls.append(
            {
                "id": entry["id"] or f"call_{uuid.uuid4().hex[:12]}",
                "name": entry["name"],
                "arguments": arguments if isinstance(arguments, dict) else {"_raw": raw_args},
            }
        )

    content_text = "".join(content_parts) or None
    return {"content": content_text, "tool_calls": tool_calls}
