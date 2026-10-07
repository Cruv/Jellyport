import asyncio
import json

import httpx
import pytest

from app.media import MediaClient, MediaError


def run(awaitable):
    return asyncio.run(awaitable)


def test_user_scoped_pagination_and_series_metadata():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["X-Emby-Token"] == "secret-token"
        assert "secret-token" not in str(request.url)
        assert request.url.path == "/emby/Users/alice/Items"
        assert request.url.params["Fields"] == "ProviderIds,Path"
        assert request.url.params["EnableUserData"] == "true"
        start = int(request.url.params["StartIndex"])
        if request.url.params["IncludeItemTypes"] == "Series":
            return httpx.Response(200, json={"Items": [{"Id": "s1", "ProviderIds": {"Tvdb": "42"}}], "TotalRecordCount": 1})
        items = [
            {"Id": "e1", "Type": "Episode", "SeriesId": "s1", "ParentIndexNumber": 1, "IndexNumber": 1, "UserData": {"Played": True}},
            {"Id": "m1", "Type": "Movie", "UserData": {"Played": False}},
            {"Id": "e2", "Type": "Episode", "SeriesId": "s1", "ParentIndexNumber": 1, "IndexNumber": 2},
        ]
        return httpx.Response(200, json={"Items": items[start:start + 2], "TotalRecordCount": len(items)})

    async def scenario():
        async with MediaClient("http://emby.test/emby/", "secret-token", kind="emby", transport=httpx.MockTransport(handler)) as client:
            client.PAGE_SIZE = 2
            items = await client.items("alice")
            assert [item["Id"] for item in items] == ["e1", "m1", "e2"]
            assert items[0]["SeriesProviderIds"] == {"Tvdb": "42"}
            assert items[2]["SeriesProviderIds"] == {"Tvdb": "42"}
            assert items[0]["UserData"]["Played"] is True
            assert items[1]["UserData"]["Played"] is False
        assert client._client.is_closed

    run(scenario())
    assert len(requests) == 3


def test_create_template_and_password_contracts():
    seen = []

    def handler(request):
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        if request.url.path.endswith("/Users/New"):
            return httpx.Response(200, json={"Id": "new-user", "Name": body["Name"], "HasPassword": True})
        return httpx.Response(204)

    async def scenario():
        async with MediaClient("http://jellyfin.test/base", "key", transport=httpx.MockTransport(handler)) as client:
            user = await client.create_user("Alice", "generated-pass")
            await client.set_policy(user["Id"], {"IsAdministrator": False, "EnableAllFolders": True})
            await client.set_configuration(user["Id"], {"AudioLanguagePreference": "eng"})
            await client.set_password(user["Id"], "replacement-pass")
            await client.mark_played(user["Id"], "movie-1")

    run(scenario())
    assert seen == [
        ("POST", "/base/Users/New", {"Name": "Alice", "Password": "generated-pass"}),
        ("POST", "/base/Users/new-user/Policy", {"IsAdministrator": False, "EnableAllFolders": True}),
        ("POST", "/base/Users/new-user/Configuration", {"AudioLanguagePreference": "eng"}),
        ("POST", "/base/Users/new-user/Password", {"CurrentPw": "", "NewPw": "replacement-pass", "ResetPassword": False}),
        ("POST", "/base/Users/new-user/PlayedItems/movie-1", None),
    ]


def test_identifiers_are_encoded_and_do_not_add_query_parameters():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"Id": "user"})

    async def scenario():
        async with MediaClient("http://jellyfin.test", "key", transport=httpx.MockTransport(handler)) as client:
            await client.user("alice/?api_key=stolen#x")

    run(scenario())
    assert seen[0].url.query == b""
    assert b"alice%2F%3Fapi_key%3Dstolen%23x" in seen[0].url.raw_path


def test_read_retries_are_bounded_and_mutations_never_retry(monkeypatch):
    counts = {"GET": 0, "POST": 0}

    async def no_sleep(_):
        pass

    monkeypatch.setattr("app.media.asyncio.sleep", no_sleep)

    def handler(request):
        counts[request.method] += 1
        return httpx.Response(503, text="upstream-secret-body", headers={"Retry-After": "36000"})

    async def scenario():
        async with MediaClient("http://jellyfin.test", "secret", transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(MediaError) as error:
                await client.users()
            assert error.value.status_code == 503
            assert "upstream-secret-body" not in str(error.value)
            with pytest.raises(MediaError):
                await client.create_user("Alice", "password")

    run(scenario())
    assert counts == {"GET": 3, "POST": 1}


def test_timeout_error_is_safe_and_creation_outcome_is_uncertain():
    def handler(request):
        raise httpx.ReadTimeout("http://secret-host?api_key=secret upstream", request=request)

    async def scenario():
        async with MediaClient("http://secret-host", "secret", transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(MediaError) as error:
                await client.create_user("Alice", "generated-pass")
            assert "may have been applied" in str(error.value)
            assert "secret" not in str(error.value)
            assert "generated-pass" not in str(error.value)

    run(scenario())


def test_repeated_library_page_does_not_loop_forever():
    def handler(request):
        return httpx.Response(200, json={"Items": [{"Id": "one", "Type": "Movie"}], "TotalRecordCount": 20})

    async def scenario():
        async with MediaClient("http://jellyfin.test", "key", transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(MediaError, match="repeated a library page"):
                await client.items()

    run(scenario())


@pytest.mark.parametrize("response", [{"not": "users"}, ["bad"]])
def test_malformed_user_response_is_rejected(response):
    async def scenario():
        async with MediaClient("http://jellyfin.test", "key", transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))) as client:
            with pytest.raises(MediaError, match="invalid user list"):
                await client.users()

    run(scenario())


@pytest.mark.parametrize("url", ["ftp://host", "http://user:password@host", "http://host?api_key=secret", "http://host/#fragment", "http://host:bad"])
def test_invalid_base_urls_are_rejected_without_disclosure(url):
    with pytest.raises(MediaError) as error:
        MediaClient(url, "key")
    assert "password" not in str(error.value)
    assert "secret" not in str(error.value)
