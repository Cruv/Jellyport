"""Regression scenarios found during an independent integration review."""

import copy

import pytest

from app.bot import BotManager
from app.demo import DemoServers
from app.media import MediaError
from app.service import Service, ServiceError
from app.store import DEFAULT_SETTINGS, Store


@pytest.fixture
def review_setup(tmp_path):
    store = Store(tmp_path)
    servers = DemoServers()
    store.save_settings(DEFAULT_SETTINGS | {
        "emby_url": "http://emby", "emby_api_key": "key",
        "jellyfin_url": "http://jellyfin", "jellyfin_api_key": "key",
        "template_user_id": "template",
    })
    service = Service(store, client_factory=servers.factory)
    yield service, store, servers
    store.close()


class MembershipBot:
    def __init__(self, active=False, departed=False):
        self.active, self.departed = active, departed

    async def membership_active(self, user_id):
        return self.active

    async def recipient_identity(self, user_id, require_membership=True):
        if self.departed:
            raise RuntimeError("Member left the guild")
        return {"id": user_id, "username": "river"}


async def test_expiration_can_disable_linked_member_who_left_discord(review_setup):
    service, store, servers = review_setup
    service.bot = MembershipBot(departed=True)
    store.save_link("123456789", "river", "j-river")
    await service.record_subscription({"id": "departed", "action": "expire", "discord_user_id": "123456789", "source": "discord_role"})
    event = await service.apply_subscription("departed")
    assert event["status"] == "applied"
    assert servers.users["jellyfin"][1]["Policy"]["IsDisabled"] is True


async def test_obsolete_expiration_is_ignored_when_membership_is_active(review_setup):
    service, store, servers = review_setup
    service.bot = MembershipBot(active=True)
    store.save_link("123456789", "river", "j-river")
    before = copy.deepcopy(servers.users["jellyfin"][1])
    await service.record_subscription({"id": "old-expiry", "action": "expire", "discord_user_id": "123456789", "source": "discord_role"})
    event = await service.apply_subscription("old-expiry")
    assert event["status"] == "ignored"
    assert servers.users["jellyfin"][1] == before


async def test_disable_timeout_after_remote_success_remains_reversible(review_setup):
    service, store, servers = review_setup
    service.bot = MembershipBot()
    store.save_link("123456789", "river", "j-river")
    factory = servers.factory
    injected = False

    def failing_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        original = client.set_policy

        async def apply_then_timeout(user_id, policy):
            nonlocal injected
            await original(user_id, policy)
            if policy.get("IsDisabled") and not injected:
                injected = True
                raise MediaError("Jellyfin request timed out. The operation may have been applied; check before retrying.")

        client.set_policy = apply_then_timeout
        return client

    service.client_factory = failing_factory
    await service.record_subscription({"id": "expire-timeout", "action": "expire", "discord_user_id": "123456789", "source": "discord_role"})
    with pytest.raises(ServiceError):
        await service.apply_subscription("expire-timeout")
    assert servers.users["jellyfin"][1]["Policy"]["IsDisabled"] is True
    await service.apply_subscription("expire-timeout")
    assert store.link("123456789")["disabled_by_jellyport"] == 1
    service.bot.active = True
    await service.record_subscription({"id": "return-after-timeout", "action": "subscribe", "discord_user_id": "123456789", "source": "discord_role"})
    await service.apply_subscription("return-after-timeout")
    assert servers.users["jellyfin"][1]["Policy"]["IsDisabled"] is False
    assert store.link("123456789")["disabled_by_jellyport"] == 0


async def test_disabled_discord_setting_prevents_gateway_start(monkeypatch):
    constructed = []

    class FakeClient:
        def __init__(self, manager, guild_id):
            constructed.append(guild_id)

        async def close(self):
            pass

        async def start(self, *args, **kwargs):
            pass

    monkeypatch.setattr("app.bot._Client", FakeClient)
    manager = BotManager(None)
    try:
        await manager.restart(DEFAULT_SETTINGS | {
            "discord_enabled": False, "discord_bot_token": "stored-token",
            "discord_guild_id": "123456789",
        })
        assert constructed == []
        assert manager.status()["enabled"] is False
    finally:
        await manager.stop()


async def test_reenable_timeout_after_remote_success_clears_disable_ownership(review_setup):
    service, store, servers = review_setup
    service.bot = MembershipBot(active=True)
    servers.users["jellyfin"][1]["Policy"]["IsDisabled"] = True
    store.save_link("123456789", "river", "j-river", True)
    factory = servers.factory
    injected = False

    def failing_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        original = client.set_policy

        async def apply_then_timeout(user_id, policy):
            nonlocal injected
            await original(user_id, policy)
            if not policy.get("IsDisabled") and not injected:
                injected = True
                raise MediaError("Jellyfin request timed out. The operation may have been applied; check before retrying.")

        client.set_policy = apply_then_timeout
        return client

    service.client_factory = failing_factory
    await service.record_subscription({"id": "subscribe-timeout", "action": "subscribe", "discord_user_id": "123456789", "source": "discord_role"})
    with pytest.raises(ServiceError):
        await service.apply_subscription("subscribe-timeout")
    assert servers.users["jellyfin"][1]["Policy"]["IsDisabled"] is False
    await service.apply_subscription("subscribe-timeout")
    assert store.link("123456789")["disabled_by_jellyport"] == 0


async def finish_job(service, job):
    task = service.job_tasks.get(job["id"])
    if task:
        await task
    return service.get_job(job["id"])


async def test_explicit_recovery_of_remote_creation_after_timeout_preserves_history(review_setup):
    service, store, servers = review_setup
    factory = servers.factory
    password_updates = []

    def uncertain_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        original_create = client.create_user
        original_password = client.set_password

        async def create_then_timeout(username, password):
            await original_create(username, password)
            raise MediaError("Jellyfin request timed out.")

        async def record_password(user_id, password):
            password_updates.append((user_id, password))
            await original_password(user_id, password)

        client.create_user, client.set_password = create_then_timeout, record_password
        return client

    service.client_factory = uncertain_factory
    failed = await finish_job(service, await service.create_account("casey"))
    assert failed["status"] == "failed"
    target = next(user for user in servers.users["jellyfin"] if user["Name"] == "casey")
    servers.played[target["Id"]] = {"1"}
    retry = await finish_job(service, await service.create_account("casey"))
    assert retry["status"] == "failed"
    assert password_updates == []
    info = await service.recovery_info("casey")
    assert info["eligible"] is True
    with pytest.raises(ServiceError):
        await service.recover_account("casey", "wrong-target")
    recovered = await finish_job(service, await service.recover_account("casey", info["target_user_id"]))
    assert recovered["status"] == "completed"
    assert len(password_updates) == 1
    assert password_updates[0][0] == target["Id"]
    assert target["Policy"] == servers.users["jellyfin"][0]["Policy"]
    assert servers.played[target["Id"]] == {"1"}
    assert store.take_credentials(recovered["id"])[0]["password"] == password_updates[0][1]


async def test_creation_authentication_rejection_can_retry_after_key_is_fixed(review_setup):
    service, store, servers = review_setup
    factory = servers.factory
    rejected = True

    def rejecting_factory(*args, **kwargs):
        client = factory(*args, **kwargs)
        original = client.create_user

        async def create(username, password):
            if rejected:
                raise MediaError("Jellyfin rejected the request (HTTP 401).", status_code=401)
            return await original(username, password)

        client.create_user = create
        return client

    service.client_factory = rejecting_factory
    first = await finish_job(service, await service.create_account("casey"))
    assert first["status"] == "failed"
    assert not any(user["Name"] == "casey" for user in servers.users["jellyfin"])
    rejected = False
    second = await finish_job(service, await service.create_account("casey"))
    assert second["status"] == "completed"
    assert len(store.take_credentials(second["id"])) == 1
