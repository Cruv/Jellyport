"""Indexed media matching without guessing from movie or series titles."""

from __future__ import annotations

from collections import defaultdict
import posixpath
import unicodedata
from typing import Any


# Collection/box-set identifiers and unknown extension metadata must not identify
# an individual movie or episode. Provider name spellings vary between servers.
_PROVIDERS = {
    "imdb": "imdb", "tmdb": "tmdb", "themoviedb": "tmdb",
    "tvdb": "tvdb", "thetvdb": "tvdb", "tvmaze": "tvmaze",
    "anidb": "anidb", "anilist": "anilist", "myanimelist": "myanimelist", "kitsu": "kitsu",
}


def _providers(item: dict[str, Any], field: str) -> dict[str, str]:
    raw = item.get(field)
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key, value in raw.items():
        provider = _PROVIDERS.get(str(key).strip().casefold())
        if provider and isinstance(value, (str, int)) and not isinstance(value, bool):
            normalized = str(value).strip().casefold()
            if normalized:
                result[provider] = normalized
    return result


def _type(item: dict[str, Any]) -> str:
    return str(item.get("Type", "")).casefold()


def _number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _episode_range(item: dict[str, Any]) -> tuple[int, int, int] | None:
    season, episode = _number(item.get("ParentIndexNumber")), _number(item.get("IndexNumber"))
    if season is None or episode is None:
        return None
    end = _number(item.get("IndexNumberEnd"))
    if end is None:
        end = episode
    if end < episode:
        return None
    return season, episode, end


def _path(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return posixpath.normpath(unicodedata.normalize("NFC", value.strip()).replace("\\", "/"))


def _mappings(values: list[dict[str, Any]]) -> list[tuple[str, str]]:
    mappings = []
    for entry in values:
        source, target = _path(entry.get("source")), _path(entry.get("target"))
        if source and target:
            mappings.append((source, target))
    return sorted(mappings, key=lambda pair: len(pair[0]), reverse=True)


def _mapped_path(item: dict[str, Any], mappings: list[tuple[str, str]]) -> str | None:
    path = _path(item.get("Path"))
    if path:
        for source, target in mappings:
            if path == source:
                return target
            prefix = source.rstrip("/") + "/"
            if path.startswith(prefix):
                return _path(target.rstrip("/") + "/" + path[len(prefix):])
    return path


def _compatible(source: dict[str, Any], target: dict[str, Any]) -> bool:
    # A path or one matching provider cannot override contradictory metadata.
    fields = ["ProviderIds"]
    if _type(source) == "episode":
        fields.append("SeriesProviderIds")
        a, b = _episode_range(source), _episode_range(target)
        if a is not None and b is not None and a != b:
            return False
    for field in fields:
        a, b = _providers(source, field), _providers(target, field)
        if any(a[key] != b[key] for key in a.keys() & b.keys()):
            return False
    return True


def match_items(
    source: list[dict[str, Any]],
    target: list[dict[str, Any]],
    path_mappings: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Match using provider identity, series+episode identity, then exact path.

    A duplicate edition with the same provider ID is ambiguous unless exact path
    distinguishes it. A shared TMDB series ID never identifies an episode alone.
    Source paths use longest boundary prefix mappings; target paths stay intact.
    Input items are retained in output and never modified.
    """
    provider_index: dict[tuple[str, str, str], set[int]] = defaultdict(set)
    series_index: dict[tuple[Any, ...], set[int]] = defaultdict(set)
    path_index: dict[tuple[str, str], set[int]] = defaultdict(set)
    for index, item in enumerate(target):
        kind = _type(item)
        if kind not in {"movie", "episode"}:
            continue
        for provider, value in _providers(item, "ProviderIds").items():
            provider_index[(kind, provider, value)].add(index)
        numbers = _episode_range(item)
        if kind == "episode" and numbers is not None:
            for provider, value in _providers(item, "SeriesProviderIds").items():
                series_index[(provider, value, *numbers)].add(index)
        path = _path(item.get("Path"))
        if path:
            path_index[(kind, path)].add(index)

    mappings = _mappings(path_mappings or [])
    result: dict[str, list[dict[str, Any]]] = {"matches": [], "unmatched": [], "ambiguous": []}
    for item in source:
        kind = _type(item)
        if kind not in {"movie", "episode"}:
            result["unmatched"].append(item)
            continue
        path = _mapped_path(item, mappings)
        path_candidates = set(path_index.get((kind, path), ())) if path else set()
        candidates: set[int] = set()
        method = "provider_id"
        for provider, value in _providers(item, "ProviderIds").items():
            candidates.update(provider_index.get((kind, provider, value), ()))
        if not candidates and kind == "episode":
            numbers = _episode_range(item)
            if numbers is not None:
                method = "series_episode"
                for provider, value in _providers(item, "SeriesProviderIds").items():
                    candidates.update(series_index.get((provider, value, *numbers), ()))
        if not candidates:
            candidates, method = path_candidates, "path"
        compatible = {index for index in candidates if _compatible(item, target[index])}
        # Conflicting providers make the source uncertain even when one candidate
        # happens to agree with just a subset. Report all possibilities for review.
        if candidates and compatible != candidates:
            result["ambiguous"].append({"source": item, "candidates": [target[i] for i in sorted(candidates)]})
            continue
        if len(candidates) > 1:
            narrowed = candidates & path_candidates
            if len(narrowed) == 1:
                candidates, method = narrowed, method + "+path"
        if len(candidates) == 1:
            index = next(iter(candidates))
            result["matches"].append({"source": item, "target": target[index], "method": method})
        elif candidates:
            result["ambiguous"].append({"source": item, "candidates": [target[i] for i in sorted(candidates)]})
        else:
            result["unmatched"].append(item)
    return result
