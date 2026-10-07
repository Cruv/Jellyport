"""Small, deliberately conservative clients for the Emby and Jellyfin APIs."""

from __future__ import annotations

import asyncio
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import httpx


class MediaError(RuntimeError):
    """A safe error suitable for display; never includes tokens or response bodies."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class MediaClient:
    """API-key client preserving any configured reverse-proxy base path.

    Mutations are never retried: a timed-out creation may have succeeded upstream.
    Both servers accept X-Emby-Token, which avoids keys in request URLs and logs.
    """

    PAGE_SIZE = 500

    def __init__(
        self,
        url: str,
        api_key: str,
        kind: Literal["jellyfin", "emby"] = "jellyfin",
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        if kind not in {"jellyfin", "emby"}:
            raise MediaError("Unsupported media server type.")
        try:
            parsed = urlsplit(url.strip())
            valid = (
                parsed.scheme in {"http", "https"}
                and bool(parsed.hostname)
                and not parsed.username
                and not parsed.password
                and not parsed.query
                and not parsed.fragment
            )
            parsed.port  # Validate malformed port numbers without disclosing the URL.
        except (ValueError, AttributeError):
            valid = False
        if not valid:
            raise MediaError("Server URL must be an HTTP(S) address without credentials or query parameters.")
        if not isinstance(api_key, str) or not api_key.strip() or "\n" in api_key or "\r" in api_key:
            raise MediaError("A valid media server API key is required.")
        self.kind = kind
        self._label = "Jellyfin" if kind == "jellyfin" else "Emby"
        self._base_url = url.strip().rstrip("/") + "/"
        self._client = httpx.AsyncClient(
            headers={"X-Emby-Token": api_key, "Accept": "application/json", "User-Agent": "Jellyport/0.1"},
            timeout=httpx.Timeout(30, connect=10),
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def __aenter__(self) -> MediaClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _id(value: str) -> str:
        if not isinstance(value, str) or not value or value in {".", ".."}:
            raise MediaError("A valid media server identifier is required.")
        return quote(value, safe="")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        decode: bool = True,
    ) -> Any:
        attempts = 3 if method == "GET" else 1
        for attempt in range(attempts):
            try:
                response = await self._client.request(
                    method, self._base_url + path.lstrip("/"), params=params, json=json
                )
            except httpx.TimeoutException:
                suffix = " The operation may have been applied; check before retrying." if method != "GET" else ""
                raise MediaError(f"{self._label} request timed out.{suffix}") from None
            except httpx.HTTPError:
                suffix = " The operation may have been applied; check before retrying." if method != "GET" else ""
                raise MediaError(f"Unable to connect to {self._label}.{suffix}") from None
            if response.status_code in {429, 503} and attempt + 1 < attempts:
                try:
                    delay = min(2.0, max(0.0, float(response.headers.get("Retry-After", "0.2"))))
                except ValueError:
                    delay = 0.2
                await asyncio.sleep(delay)
                continue
            if not 200 <= response.status_code < 300:
                raise MediaError(
                    f"{self._label} rejected the request (HTTP {response.status_code}).",
                    status_code=response.status_code,
                )
            if not decode or response.status_code == 204:
                return None
            try:
                return response.json()
            except (ValueError, UnicodeDecodeError):
                raise MediaError(f"{self._label} returned an invalid API response.") from None
        raise MediaError(f"{self._label} request failed.")  # Defensive; loop always returns or raises.

    def _object(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise MediaError(f"{self._label} returned an invalid API response.")
        return data

    async def system_info(self) -> dict[str, Any]:
        return self._object(await self._request("GET", "System/Info"))

    async def users(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "Users")
        if not isinstance(data, list) or any(not isinstance(user, dict) for user in data):
            raise MediaError(f"{self._label} returned an invalid user list.")
        return data

    async def user(self, user_id: str) -> dict[str, Any]:
        return self._object(await self._request("GET", f"Users/{self._id(user_id)}"))

    async def _items_by_type(self, user_id: str | None, item_types: str) -> list[dict[str, Any]]:
        path = f"Users/{self._id(user_id)}/Items" if user_id is not None else "Items"
        items: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        start = 0
        while True:
            data = self._object(await self._request("GET", path, params={
                "IncludeItemTypes": item_types,
                "Recursive": "true",
                "Fields": "ProviderIds,Path",
                "EnableUserData": "true" if user_id is not None else "false",
                "EnableImages": "false",
                "SortBy": "SortName",
                "SortOrder": "Ascending",
                "StartIndex": start,
                "Limit": self.PAGE_SIZE,
                "EnableTotalRecordCount": "true",
            }))
            page = data.get("Items")
            if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
                raise MediaError(f"{self._label} returned an invalid library page.")
            if not page:
                break
            if any(not isinstance(item.get("Id"), str) or not item["Id"] for item in page):
                raise MediaError(f"{self._label} returned library items without identifiers.")
            ids = {item["Id"] for item in page}
            # A server ignoring StartIndex must not trap a migration in an endless loop.
            if ids <= seen_ids:
                raise MediaError(f"{self._label} repeated a library page; refresh the library and retry.")
            items.extend(item for item in page if item["Id"] not in seen_ids)
            seen_ids.update(ids)
            start += len(page)
            total = data.get("TotalRecordCount")
            if isinstance(total, int) and not isinstance(total, bool) and total >= 0:
                if start >= total:
                    break
            elif len(page) < self.PAGE_SIZE:
                break
            if start > 2_000_000:
                raise MediaError(f"{self._label} library exceeds the supported migration size.")
        return items

    async def items(self, user_id: str | None = None) -> list[dict[str, Any]]:
        """Return user-scoped movies/episodes, including series identity when known.

        Season, episode, series name and year are standard BaseItemDto properties;
        only Path and ProviderIds belong in Fields. SeriesProviderIds is enriched
        locally because it is not a supported Jellyfin ItemFields enum value.
        """
        items = await self._items_by_type(user_id, "Movie,Episode")
        needs_series = {
            item.get("SeriesId") for item in items
            if item.get("Type") == "Episode" and item.get("SeriesId") and not item.get("SeriesProviderIds")
        }
        if needs_series:
            series = await self._items_by_type(user_id, "Series")
            providers = {
                item["Id"]: item["ProviderIds"] for item in series
                if item["Id"] in needs_series and isinstance(item.get("ProviderIds"), dict)
            }
            for item in items:
                if item.get("SeriesId") in providers and not item.get("SeriesProviderIds"):
                    item["SeriesProviderIds"] = dict(providers[item["SeriesId"]])
        return items

    async def create_user(self, name: str, password: str) -> dict[str, Any]:
        if self.kind != "jellyfin":
            raise MediaError("Account creation is supported only on Jellyfin.")
        if not name.strip() or not password:
            raise MediaError("A username and nonempty password are required.")
        # Jellyfin accepts both in one request, but the server does not promise a
        # transaction. The caller must reconcile uncertain outcomes by username.
        return self._object(await self._request("POST", "Users/New", json={"Name": name, "Password": password}))

    async def set_password(self, user_id: str, password: str) -> None:
        if self.kind != "jellyfin" or not password:
            raise MediaError("A nonempty Jellyfin password is required.")
        await self._request("POST", f"Users/{self._id(user_id)}/Password", json={
            "CurrentPw": "", "NewPw": password, "ResetPassword": False,
        }, decode=False)

    async def set_policy(self, user_id: str, policy: dict[str, Any]) -> None:
        await self._request("POST", f"Users/{self._id(user_id)}/Policy", json=policy, decode=False)

    async def set_configuration(self, user_id: str, configuration: dict[str, Any]) -> None:
        await self._request("POST", f"Users/{self._id(user_id)}/Configuration", json=configuration, decode=False)

    async def mark_played(self, user_id: str, item_id: str) -> None:
        await self._request("POST", f"Users/{self._id(user_id)}/PlayedItems/{self._id(item_id)}", decode=False)
